-- コードレビュー(2026-10-03)で確定したバグの修正
--  [送信待ち] 送信待ちが翌日に届くと、届いた日の日付で記録されていた → 画面が来院日(visit_date)を送り、
--             DB は今日か前日だけ受け付ける。料金・回数券の期限・クレジットの有効期限は来院日で判定
--
--  [お金] 1. 期限切れのクレジットにも使用額が割り当てられ、失効処理(cron)前は同じ残高を二重に使えた
--         2. owner が過去の来店を取り消すと、FIFO の再計算で使用が失効済みの付与に付け替わり、残高が無償で増えた
--         → 使用時に「どの付与からいくら使ったか」を credit_allocations に記録する方式に変更。
--           割当はその日に有効な付与にだけ行う。取消は割当ごと戻る。失効処理は pg_cron で毎日実行
--         7. 取消と回数券の使用が同時に走ると、取消済みの回数券で施術できた → 取消時に回数券・患者・紹介者の行をロック
--  [権限] 3. 予約の一時停止が anon にしか効いていなかった → authenticated からも外す
--         6. get_patient_card が他店舗の当日メモ・回数券を返した → 自店舗に限定
--         - 冪等キーが関数・ユーザーをまたいで共有されていた → (関数, 実行者) が一致したときだけ前回の結果を返す
--         - 冪等の確認が行ロックの前にあり、同時再送で二重記録になりえた → ロック後にもう一度確認
--         - 他店舗の回数券を使えた → 自店舗の回数券のみ
--         - スタッフが customers の code / user_id / line_user_id / referred_by を書き換えられた → 列単位の権限に
--         - next_customer_code() を非スタッフのログインユーザーが呼べた → 関数内で確認
--         - Supabase では public の関数に anon の実行権限が直接付く → 既定で閉じ、使う関数だけ開ける
--  [問診] 4. main_symptom / safety / disliked を省略すると検証をすり抜けた(NULL の扱い)→ 修正
--         5. 氏名+電話を知っていれば未ログインで既存患者のふりがな・言語を上書きできた
--            → 既存患者に一致したときはマスタを上書きせず、問診に matched_existing を付けてスタッフが確認する
--         - 回数制限の確認がロックの前にあった → ロック後に。店舗全体の 1 日の上限も追加

-- ═════════════════════════════════════════════
-- 冪等性: (関数, 実行者) ごと
-- ═════════════════════════════════════════════
alter table private.idempotency add column if not exists actor uuid;

create or replace function private.idem_get(p_request uuid, p_fn text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v private.idempotency;
begin
  select * into v from private.idempotency i where i.request_id = p_request;
  if v.request_id is null then
    return null;
  end if;
  if v.fn <> p_fn or v.actor is distinct from auth.uid() then
    raise exception 'request_id_conflict' using errcode = 'P0001';
  end if;
  return v.result;
end;
$$;

create or replace function private.idem_put(p_request uuid, p_fn text, p_result jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.idempotency (request_id, fn, result, actor) values (p_request, p_fn, p_result, auth.uid());
$$;

-- ═════════════════════════════════════════════
-- クレジット: 使用ごとの割当
-- ═════════════════════════════════════════════
create table public.credit_allocations (
  id          uuid primary key default gen_random_uuid(),
  use_id      uuid not null references public.credit_entries(id),
  grant_id    uuid not null references public.credit_entries(id),
  amount      integer not null check (amount > 0),
  created_at  timestamptz not null default now()
);
create index on public.credit_allocations (use_id);
create index on public.credit_allocations (grant_id);
alter table public.credit_allocations enable row level security;
revoke all on public.credit_allocations from anon, authenticated;
grant select on public.credit_allocations to authenticated;
create policy credit_allocations_staff_select on public.credit_allocations for select to authenticated
  using (private.is_any_staff());

-- 付与ごとの残り(マイナス = 取消された付与がすでに使われていた不足分)
create or replace function private.grant_remaining(p_grant uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select g.amount
       + coalesce((select sum(x.amount) from public.credit_entries x
                   where x.reverses_id = g.id and x.kind in ('expire', 'void')), 0)::integer
       - coalesce((select sum(a.amount) from public.credit_allocations a
                   where a.grant_id = g.id
                     and not exists (select 1 from public.credit_entries v
                                     where v.reverses_id = a.use_id and v.kind = 'void')), 0)::integer
  from public.credit_entries g where g.id = p_grant;
$$;

-- 付与ごとの残り(互換のため旧 credit_lots と同じ列)。unassigned = 不足分
create or replace function private.credit_lots(p_customer uuid)
returns table (grant_id uuid, expires_on date, remaining integer, unassigned integer)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.expires_on, greatest(r.rem, 0), greatest(-r.rem, 0)
  from public.credit_entries g, lateral (select private.grant_remaining(g.id) as rem) r
  where g.customer_id = p_customer and g.kind = 'grant'
  order by g.expires_on, g.created_at, g.id;
$$;

create or replace function private.credit_available(p_customer uuid, p_as_of date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce(sum(l.remaining) filter (where l.expires_on >= p_as_of), 0) - coalesce(sum(l.unassigned), 0),
    0)::integer
  from private.credit_lots(p_customer) l;
$$;

-- 使用を、その日に有効な付与へ期限の近い順に割り当てる(呼び出し元で顧客の行をロック済みであること)
create or replace function private.allocate_credit_use(p_use uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  u public.credit_entries;
  v_left integer;
  g record;
  v_take integer;
begin
  select * into u from public.credit_entries where id = p_use and kind = 'use';
  v_left := -u.amount;
  for g in
    select e.id, private.grant_remaining(e.id) as rem
    from public.credit_entries e
    where e.customer_id = u.customer_id and e.kind = 'grant' and e.expires_on >= u.occurred_on
    order by e.expires_on, e.created_at, e.id
  loop
    exit when v_left <= 0;
    continue when g.rem <= 0;
    v_take := least(g.rem, v_left);
    insert into public.credit_allocations (use_id, grant_id, amount) values (p_use, g.id, v_take);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    raise exception 'insufficient_credit:%', -u.amount - v_left using errcode = 'P0001';
  end if;
end;
$$;

-- 既存の使用に割当を付ける(テスト環境の既存データ用。使用日に有効だった付与へ時系列順に)
do $$
declare
  u record;
begin
  for u in select e.id from public.credit_entries e where e.kind = 'use'
           and not exists (select 1 from public.credit_allocations a where a.use_id = e.id)
           order by e.created_at, e.id
  loop
    begin
      perform private.allocate_credit_use(u.id);
    exception when others then
      raise notice 'credit use % could not be fully allocated: %', u.id, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function public.expire_credits(p_as_of date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Tokyo')::date);
  g record;
  n integer := 0;
begin
  for g in
    select e.id, e.customer_id, private.grant_remaining(e.id) as rem
    from public.credit_entries e
    where e.kind = 'grant' and e.expires_on < v_as_of
    for update of e
  loop
    if g.rem > 0 then
      insert into public.credit_entries (customer_id, kind, amount, reverses_id, occurred_on)
      values (g.customer_id, 'expire', -g.rem, g.id, v_as_of);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ═════════════════════════════════════════════
-- 施術記録
-- ═════════════════════════════════════════════
create or replace function public.record_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_referral_amount constant integer := 1000;
  c_referral_limit  constant integer := 3;

  v_request   uuid := (p->>'request_id')::uuid;
  v_prev      jsonb;
  v_staff     public.staff;
  v_store     public.stores;
  v_today     date;
  v_vdate     date;   -- 来院日(既定は今日。送信待ちが翌日に届いた場合は前日)
  v_customer  public.customers;
  v_referrer  public.customers;
  v_menu      public.menus;
  v_product   public.products;
  v_pass      public.passes;
  v_attended  boolean := coalesce((p->>'attended')::boolean, true);
  v_reason    text := nullif(trim(coalesce(p->>'no_show_reason', '')), '');
  v_same_day  boolean := coalesce((p->>'allow_same_day')::boolean, false);
  v_use_pass  uuid := nullif(p->>'use_pass_id', '')::uuid;
  v_buy       uuid := nullif(p->>'purchase_product_id', '')::uuid;
  v_use_buy   boolean := coalesce((p->>'use_purchased_pass')::boolean, false);
  v_method    text := nullif(p->>'payment_method', '');
  v_credit    integer := coalesce((p->>'credit_use')::integer, 0);
  v_ref_id    uuid := nullif(p->>'referrer_id', '')::uuid;
  v_change    text := nullif(p->>'change_from_last', '');
  v_memo      text := nullif(trim(coalesce(p->>'memo', '')), '');
  v_covered   boolean := false;
  v_menu_chg  integer := 0;
  v_prod_chg  integer := 0;
  v_discount  integer := 0;
  v_subtotal  integer;
  v_total     integer;
  v_available integer;
  v_visit_id  uuid := gen_random_uuid();
  v_use_id    uuid;
  v_new_pass  uuid;
  v_valid_to  date;
  v_ref_count integer;
  v_ref_limit boolean := false;
  v_result    jsonb;
begin
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request, 'record_visit');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  v_staff := private.current_staff(nullif(p->>'store_id', '')::uuid);
  select * into v_store from public.stores where id = v_staff.store_id;
  v_today := private.store_today(v_store.id);
  begin
    v_vdate := coalesce(nullif(p->>'visit_date', '')::date, v_today);
  exception when others then
    raise exception 'visit_date_invalid' using errcode = 'P0001';
  end;
  -- オフラインで記録して翌日に届く場合を許すため、前日まで。それより前は owner が別途対応
  if v_vdate > v_today or v_vdate < v_today - 1 then
    raise exception 'visit_date_invalid' using errcode = 'P0001';
  end if;

  -- 同じ顧客への同時記録を直列化(残高チェックの競合防止)
  select * into v_customer from public.customers
  where id = (p->>'customer_id')::uuid for update;
  if v_customer.id is null or v_customer.status <> 'active' then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;
  -- 同じ request_id の同時再送: 先の処理が終わるのをロックで待ったので、もう一度確認する
  v_prev := private.idem_get(v_request, 'record_visit');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  if not v_same_day and exists (
    select 1 from public.visits x
    where x.customer_id = v_customer.id and x.visit_date = v_vdate and x.status = 'recorded'
  ) then
    raise exception 'already_recorded_today' using errcode = 'P0001';
  end if;

  if not v_attended then
    if v_reason is null then
      raise exception 'no_show_reason_required' using errcode = 'P0001';
    end if;
    insert into public.visits (id, store_id, customer_id, staff_id, visit_date, attended,
                               no_show_reason, change_from_last, memo, request_id)
    values (v_visit_id, v_store.id, v_customer.id, v_staff.id, v_vdate, false,
            v_reason, v_change, v_memo, v_request);
    v_result := jsonb_build_object('visit_id', v_visit_id, 'attended', false, 'total', 0);
    perform private.idem_put(v_request, 'record_visit', v_result);
    return v_result;
  end if;

  select * into v_menu from public.menus
  where id = nullif(p->>'menu_id', '')::uuid and store_id = v_store.id and active;
  if v_menu.id is null then
    raise exception 'menu_invalid' using errcode = 'P0001';
  end if;

  if v_use_pass is not null and v_buy is not null and v_use_buy then
    raise exception 'pass_conflict' using errcode = 'P0001';
  end if;
  if v_use_pass is not null then
    select * into v_pass from public.passes where id = v_use_pass for update;
    if v_pass.id is null or v_pass.customer_id <> v_customer.id or v_pass.store_id <> v_store.id
       or v_pass.status <> 'active' or v_vdate not between v_pass.valid_from and v_pass.valid_until then
      raise exception 'pass_invalid' using errcode = 'P0001';
    end if;
    if private.pass_remaining(v_pass.id) <= 0 then
      raise exception 'pass_used_up' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = v_pass.product_id;
    if v_product.menu_ids is not null and not (v_menu.id = any (v_product.menu_ids)) then
      raise exception 'pass_menu_not_allowed' using errcode = 'P0001';
    end if;
    v_covered := true;
    v_product := null;
  end if;

  if v_buy is not null then
    select * into v_product from public.products
    where id = v_buy and store_id = v_store.id and active;
    if v_product.id is null then
      raise exception 'product_invalid' using errcode = 'P0001';
    end if;
    v_prod_chg := v_product.price;
    if v_use_buy then
      if v_product.menu_ids is not null and not (v_menu.id = any (v_product.menu_ids)) then
        raise exception 'pass_menu_not_allowed' using errcode = 'P0001';
      end if;
      v_covered := true;
    end if;
  end if;

  v_menu_chg := case when v_covered then 0 else v_menu.price end;

  if v_ref_id is not null then
    if v_ref_id = v_customer.id then
      raise exception 'referrer_invalid' using errcode = 'P0001';
    end if;
    select * into v_referrer from public.customers where id = v_ref_id for update;
    if v_referrer.id is null or v_referrer.status <> 'active' then
      raise exception 'referrer_invalid' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.visits x
               where x.customer_id = v_customer.id and x.attended and x.status = 'recorded') then
      raise exception 'referral_not_first_visit' using errcode = 'P0001';
    end if;
    if v_credit > 0 then
      raise exception 'referral_and_credit' using errcode = 'P0001';
    end if;
    v_discount := c_referral_amount;
  end if;

  v_subtotal := greatest(v_menu_chg + v_prod_chg - v_discount, 0);

  if v_credit < 0 then
    raise exception 'credit_invalid' using errcode = 'P0001';
  end if;
  if v_credit > 0 then
    v_available := private.credit_available(v_customer.id, v_vdate);
    if v_credit > v_available then
      raise exception 'insufficient_credit:%', v_available using errcode = 'P0001';
    end if;
    if v_credit > v_subtotal then
      raise exception 'credit_exceeds_amount' using errcode = 'P0001';
    end if;
  end if;

  v_total := v_subtotal - v_credit;
  if v_total > 0 and (v_method is null or v_method not in ('cash', 'card', 'paypay', 'unpaid', 'other')) then
    raise exception 'payment_method_required' using errcode = 'P0001';
  end if;

  insert into public.visits (id, store_id, customer_id, staff_id, visit_date, attended, menu_id,
                             change_from_last, memo, referrer_id, request_id)
  values (v_visit_id, v_store.id, v_customer.id, v_staff.id, v_vdate, true, v_menu.id,
          v_change, v_memo, v_ref_id, v_request);

  if v_total > 0 then
    insert into public.sales (store_id, customer_id, visit_id, kind, amount, method, breakdown, occurred_on)
    values (v_store.id, v_customer.id, v_visit_id, 'sale', v_total, v_method,
            jsonb_build_object('menu_price', v_menu_chg, 'product_price', v_prod_chg,
                               'referral_discount', v_discount, 'credit_used', v_credit,
                               'menu_code', v_menu.code, 'product_code', v_product.code),
            v_vdate);
  end if;

  if v_credit > 0 then
    insert into public.credit_entries (customer_id, store_id, kind, amount, visit_id, occurred_on)
    values (v_customer.id, v_store.id, 'use', -v_credit, v_visit_id, v_vdate)
    returning id into v_use_id;
    perform private.allocate_credit_use(v_use_id);
  end if;

  if v_buy is not null then
    v_valid_to := case v_product.validity
      when 'end_of_month' then (date_trunc('month', v_vdate) + interval '1 month - 1 day')::date
      else v_vdate + v_product.valid_days - 1
    end;
    insert into public.passes (store_id, customer_id, product_id, total_uses, valid_from, valid_until, visit_id)
    values (v_store.id, v_customer.id, v_product.id, v_product.uses, v_vdate, v_valid_to, v_visit_id)
    returning id into v_new_pass;
    if v_use_buy then
      insert into public.pass_uses (pass_id, visit_id, delta) values (v_new_pass, v_visit_id, -1);
    end if;
  end if;

  if v_use_pass is not null then
    insert into public.pass_uses (pass_id, visit_id, delta) values (v_use_pass, v_visit_id, -1);
  end if;

  if v_ref_id is not null then
    if v_customer.referred_by is null then
      update public.customers set referred_by = v_ref_id where id = v_customer.id;
    end if;
    select count(*) into v_ref_count
    from public.credit_entries g
    where g.customer_id = v_ref_id and g.kind = 'grant' and g.reason = 'referral'
      and not exists (select 1 from public.credit_entries x where x.reverses_id = g.id and x.kind = 'void');
    if v_ref_count < c_referral_limit then
      insert into public.credit_entries (customer_id, store_id, kind, amount, reason, expires_on, visit_id, occurred_on)
      values (v_ref_id, v_store.id, 'grant', c_referral_amount, 'referral',
              (v_vdate + interval '1 year')::date, v_visit_id, v_vdate);
    else
      v_ref_limit := true;
    end if;
  end if;

  v_result := jsonb_build_object(
    'visit_id', v_visit_id,
    'attended', true,
    'total', v_total,
    'breakdown', jsonb_build_object('menu_price', v_menu_chg, 'product_price', v_prod_chg,
                                    'referral_discount', v_discount, 'credit_used', v_credit),
    'pass_id', coalesce(v_new_pass, v_use_pass),
    'referral_limit_reached', v_ref_limit,
    'credit_available', private.credit_available(v_customer.id, v_vdate)
  );
  perform private.idem_put(v_request, 'record_visit', v_result);
  return v_result;
end;
$$;

-- ═════════════════════════════════════════════
-- 取消
-- ═════════════════════════════════════════════
create or replace function public.void_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request  uuid := (p->>'request_id')::uuid;
  v_prev     jsonb;
  v_visit    public.visits;
  v_staff    public.staff;
  v_today    date;
  v_reason   text := nullif(trim(coalesce(p->>'reason', '')), '');
  r          record;
  v_result   jsonb;
begin
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request, 'void_visit');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;
  if v_reason is null then
    raise exception 'void_reason_required' using errcode = 'P0001';
  end if;

  select * into v_visit from public.visits where id = (p->>'visit_id')::uuid;
  if v_visit.id is null then
    raise exception 'visit_not_found' using errcode = 'P0001';
  end if;
  v_staff := private.current_staff(v_visit.store_id);

  -- ロックの順番は record_visit と同じ(患者 → 紹介者)にしてデッドロックを避ける
  perform 1 from public.customers where id = v_visit.customer_id for update;
  if v_visit.referrer_id is not null then
    perform 1 from public.customers where id = v_visit.referrer_id for update;
  end if;
  select * into v_visit from public.visits where id = v_visit.id for update;
  -- この来店で購入した回数券を先にロック(同時に使用されると取消済みの回数券で施術できてしまうため)
  perform 1 from public.passes where visit_id = v_visit.id for update;

  v_prev := private.idem_get(v_request, 'void_visit');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;
  if v_visit.status <> 'recorded' then
    raise exception 'already_voided' using errcode = 'P0001';
  end if;
  v_today := private.store_today(v_visit.store_id);
  if v_visit.visit_date <> v_today and v_staff.role <> 'owner' then
    raise exception 'void_past_requires_owner' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.passes ps join public.pass_uses u on u.pass_id = ps.id
    where ps.visit_id = v_visit.id and ps.status = 'active'
      and u.visit_id is distinct from v_visit.id and u.delta = -1
      and not exists (select 1 from public.pass_uses rv where rv.reverses_id = u.id)
  ) then
    raise exception 'pass_in_use' using errcode = 'P0001';
  end if;

  update public.visits
  set status = 'voided', voided_at = now(), void_reason = v_reason
  where id = v_visit.id;

  for r in select s.* from public.sales s
           where s.visit_id = v_visit.id and s.kind = 'sale'
             and not exists (select 1 from public.sales x where x.reverses_id = s.id)
  loop
    insert into public.sales (store_id, customer_id, visit_id, kind, amount, method, breakdown, reverses_id, occurred_on)
    values (r.store_id, r.customer_id, r.visit_id, 'void', -r.amount, r.method,
            jsonb_build_object('reason', v_reason), r.id, v_today);
  end loop;

  -- クレジット: 使用の取消で割当が外れ、付与(紹介)の取消は付与ごと打ち消す
  for r in select e.* from public.credit_entries e
           where e.visit_id = v_visit.id and e.kind in ('use', 'grant')
             and not exists (select 1 from public.credit_entries x where x.reverses_id = e.id and x.kind = 'void')
  loop
    insert into public.credit_entries (customer_id, store_id, kind, amount, reason, visit_id, reverses_id, occurred_on)
    values (r.customer_id, r.store_id, 'void', -r.amount, v_reason, v_visit.id, r.id, v_today);
  end loop;

  for r in select u.* from public.pass_uses u
           where u.visit_id = v_visit.id and u.delta = -1
             and not exists (select 1 from public.pass_uses x where x.reverses_id = u.id)
  loop
    insert into public.pass_uses (pass_id, visit_id, delta, reverses_id) values (r.pass_id, v_visit.id, 1, r.id);
  end loop;

  update public.passes set status = 'voided' where visit_id = v_visit.id and status = 'active';

  v_result := jsonb_build_object('visit_id', v_visit.id, 'voided', true);
  perform private.idem_put(v_request, 'void_visit', v_result);
  return v_result;
end;
$$;

-- ═════════════════════════════════════════════
-- 患者カード(自店舗の当日記録・回数券のみ)
-- ═════════════════════════════════════════════
create or replace function public.get_patient_card(p_customer uuid, p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff  public.staff;
  v_today  date;
  v_c      public.customers;
begin
  v_staff := private.current_staff(p_store);
  v_today := private.store_today(v_staff.store_id);
  select * into v_c from public.customers where id = p_customer;
  if v_c.id is null then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'code', v_c.code, 'name', v_c.name,
                                   'furigana', v_c.furigana, 'lang', v_c.lang, 'status', v_c.status,
                                   'referred_by', v_c.referred_by),
    'visit_count', (select count(*) from public.visits v
                    where v.customer_id = v_c.id and v.attended and v.status = 'recorded'),
    'last_visit_before_today', (select max(v.visit_date) from public.visits v
                                where v.customer_id = v_c.id and v.attended and v.status = 'recorded'
                                  and v.visit_date < v_today),
    'is_first_visit', not exists (select 1 from public.visits v
                                  where v.customer_id = v_c.id and v.attended and v.status = 'recorded'),
    'credit_available', private.credit_available(v_c.id, v_today),
    'credit_expiring', coalesce((select jsonb_agg(jsonb_build_object('expires_on', l.expires_on, 'amount', l.remaining)
                                                  order by l.expires_on)
                                 from private.credit_lots(v_c.id) l
                                 where l.remaining > 0 and l.expires_on between v_today and v_today + 30), '[]'::jsonb),
    'passes', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', ps.id, 'product_code', pr.code, 'name', pr.name,
                                 'remaining', private.pass_remaining(ps.id),
                                 'valid_until', ps.valid_until, 'menu_ids', pr.menu_ids)
                                 order by ps.valid_until)
                        from public.passes ps join public.products pr on pr.id = ps.product_id
                        where ps.customer_id = v_c.id and ps.store_id = v_staff.store_id and ps.status = 'active'
                          and v_today between ps.valid_from and ps.valid_until
                          and private.pass_remaining(ps.id) > 0), '[]'::jsonb),
    'today_visits', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', v.id, 'attended', v.attended, 'menu_id', v.menu_id,
                                 'status', v.status, 'memo', v.memo,
                                 'total', (select coalesce(sum(s.amount), 0) from public.sales s where s.visit_id = v.id))
                                 order by v.created_at)
                              from public.visits v
                              where v.customer_id = v_c.id and v.store_id = v_staff.store_id
                                and v.visit_date = v_today), '[]'::jsonb)
  );
end;
$$;

-- ═════════════════════════════════════════════
-- 問診票
-- ═════════════════════════════════════════════
alter table public.questionnaires add column if not exists matched_existing boolean not null default false;

-- NULL(項目の省略)は「許可リストに含まれない」= false
create or replace function private.all_in(arr jsonb, allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(arr) = 'array'
     and not exists (select 1 from jsonb_array_elements_text(arr) x where not (x = any (allowed))), false);
$$;

create or replace function public.submit_questionnaire(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_per_phone constant integer := 5;     -- 同じ電話番号から 1 日
  c_per_store constant integer := 100;   -- 店舗全体で 1 日(いたずら対策)
  v_request   uuid;
  v_prev      jsonb;
  v_store     uuid;
  v_today     date;
  v_name      text := trim(coalesce(p->>'name', ''));
  v_furigana  text := nullif(trim(coalesce(p->>'furigana', '')), '');
  v_phone     text := public.normalize_phone(p->>'phone');
  v_email     text := nullif(lower(trim(coalesce(p->>'email', ''))), '');
  v_birth     date;
  v_lang      text := coalesce(p->>'lang', 'ja');
  v_how       text := nullif(p->>'how_found', '');
  a           jsonb := coalesce(p->'answers', '{}'::jsonb);
  v_images    jsonb := coalesce(p->'image_paths', '{}'::jsonb);
  v_pain      integer;
  v_consent   boolean;
  v_customer  public.customers;
  v_matched   boolean := false;
  v_matches   integer;
  v_recent    integer;
  k           text;
begin
  begin
    v_request := (p->>'request_id')::uuid;
  exception when others then
    raise exception 'request_id_required' using errcode = 'P0001';
  end;
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request, 'submit_questionnaire');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    v_store := null;
  end;
  if v_store is null or not exists (select 1 from public.stores s where s.id = v_store) then
    raise exception 'store_invalid' using errcode = 'P0001';
  end if;
  v_today := private.store_today(v_store);

  if length(v_name) = 0 or length(v_name) > 60 then
    raise exception 'name_invalid' using errcode = 'P0001';
  end if;
  if v_furigana is not null and length(v_furigana) > 60 then
    raise exception 'furigana_invalid' using errcode = 'P0001';
  end if;
  if v_phone !~ '^0\d{9,10}$' then
    raise exception 'phone_invalid' using errcode = 'P0001';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email_invalid' using errcode = 'P0001';
  end if;
  begin
    v_birth := (p->>'birth_date')::date;
  exception when others then
    raise exception 'birth_date_invalid' using errcode = 'P0001';
  end;
  if v_birth is null or v_birth < date '1900-01-01' or v_birth > v_today then
    raise exception 'birth_date_invalid' using errcode = 'P0001';
  end if;
  if v_lang not in ('ja', 'es', 'pt') then
    raise exception 'lang_invalid' using errcode = 'P0001';
  end if;
  if v_how is null or v_how not in ('instagram', 'google', 'google_maps', 'referral', 'other') then
    raise exception 'how_found_invalid' using errcode = 'P0001';
  end if;
  if jsonb_typeof(a) <> 'object' then
    raise exception 'answers_invalid' using errcode = 'P0001';
  end if;

  if not private.all_in(a->'main_symptom', array['shoulder_stiff', 'lower_back', 'neck_stiff', 'headache', 'posture', 'fatigue', 'swelling', 'other'])
     or jsonb_array_length(a->'main_symptom') = 0 then
    raise exception 'main_symptom_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'symptom_duration', '') not in ('within_week', 'within_month', 'over_month', 'over_half_year', 'other') then
    raise exception 'symptom_duration_invalid' using errcode = 'P0001';
  end if;
  begin
    v_pain := (a->>'pain_level')::integer;
  exception when others then
    raise exception 'pain_level_invalid' using errcode = 'P0001';
  end;
  if v_pain is null or v_pain not between 0 and 10 then
    raise exception 'pain_level_invalid' using errcode = 'P0001';
  end if;
  if not private.all_in(a->'safety', array['pregnant', 'hospital', 'osteoporosis', 'blood_thinner', 'numbness', 'recent_injury', 'none'])
     or jsonb_array_length(a->'safety') = 0
     or (a->'safety' ? 'none' and jsonb_array_length(a->'safety') > 1) then
    raise exception 'safety_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'treatment_goal', '') not in ('relax', 'pain_relief', 'posture_goal', 'maintenance') then
    raise exception 'treatment_goal_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'treatment_strength', '') not in ('light', 'normal', 'strong') then
    raise exception 'treatment_strength_invalid' using errcode = 'P0001';
  end if;
  if not private.all_in(a->'disliked', array['strong_pressure', 'joint_adjustment', 'none'])
     or jsonb_array_length(a->'disliked') = 0
     or (a->'disliked' ? 'none' and jsonb_array_length(a->'disliked') > 1) then
    raise exception 'disliked_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'photo_consent', '') not in ('yes', 'no') then
    raise exception 'photo_consent_invalid' using errcode = 'P0001';
  end if;
  if a->>'photo_consent' = 'yes' and coalesce(a->>'face_preference', '') not in ('face_ok', 'no_face') then
    raise exception 'face_preference_invalid' using errcode = 'P0001';
  end if;
  begin
    v_consent := (a->>'consent_agreed')::boolean;
  exception when others then
    v_consent := false;
  end;
  if v_consent is not true then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  foreach k in array array['main_symptom_other', 'symptom_duration_other', 'safety_note', 'referrer_name', 'how_found_other'] loop
    if length(coalesce(a->>k, '')) > 500 then
      raise exception 'text_too_long' using errcode = 'P0001';
    end if;
  end loop;
  if length(a::text) > 20000 then
    raise exception 'answers_too_large' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_images) <> 'object'
     or exists (select 1 from jsonb_object_keys(v_images) x where x not in ('body', 'signature'))
     or exists (select 1 from jsonb_each(v_images) e
                where jsonb_typeof(e.value) <> 'string'
                   or (e.value #>> '{}') !~ ('^q/' || v_request::text || '/(body|signature)\.(png|jpg|webp)$')) then
    raise exception 'image_path_invalid' using errcode = 'P0001';
  end if;
  if not v_images ? 'signature' then
    raise exception 'signature_required' using errcode = 'P0001';
  end if;

  -- 同じ電話番号・同じ店舗の送信を直列化してから回数を数える(同時送信で上限を超えないように)
  perform pg_advisory_xact_lock(hashtext('questionnaire:' || v_phone));
  perform pg_advisory_xact_lock(hashtext('questionnaire-store:' || v_store::text));
  v_prev := private.idem_get(v_request, 'submit_questionnaire');
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;
  select count(*) into v_recent from public.questionnaires q
  where q.phone_normalized = v_phone and q.submitted_at > now() - interval '1 day';
  if v_recent >= c_per_phone then
    raise exception 'too_many_submissions' using errcode = 'P0001';
  end if;
  select count(*) into v_recent from public.questionnaires q
  where q.store_id = v_store and q.submitted_at > now() - interval '1 day';
  if v_recent >= c_per_store then
    raise exception 'too_many_submissions' using errcode = 'P0001';
  end if;

  select count(*) into v_matches from public.customers c
  where c.phone_normalized = v_phone and private.name_key(c.name) = private.name_key(v_name) and c.status = 'active';

  if v_matches = 1 then
    -- 既存の患者: マスタは上書きしない(空の項目だけ補う)。問診は「既存患者に一致」としてスタッフが確認する
    select * into v_customer from public.customers c
    where c.phone_normalized = v_phone and private.name_key(c.name) = private.name_key(v_name) and c.status = 'active';
    update public.customers c set
      furigana   = coalesce(c.furigana, v_furigana),
      birth_date = coalesce(c.birth_date, v_birth),
      email      = coalesce(c.email, v_email),
      how_found  = case when cardinality(c.how_found) = 0 then array[v_how] else c.how_found end
    where c.id = v_customer.id;
    v_matched := true;
  else
    insert into public.customers (name, furigana, phone_normalized, email, birth_date, lang, how_found)
    values (v_name, v_furigana, v_phone, v_email, v_birth, v_lang, array[v_how])
    returning * into v_customer;
  end if;

  insert into public.questionnaires (store_id, customer_id, lang, answers, pain_areas, image_paths, phone_normalized,
                                     request_id, matched_existing)
  values (v_store, v_customer.id, v_lang, a,
          coalesce((select array_agg(x) from jsonb_array_elements_text(a->'main_symptom') x), '{}'),
          v_images, v_phone, v_request, v_matched);

  if not v_matched then
    insert into public.customer_consents (customer_id, kind) values (v_customer.id, 'privacy');
  end if;

  perform private.idem_put(v_request, 'submit_questionnaire', jsonb_build_object('accepted', true));
  return jsonb_build_object('accepted', true);
end;
$$;

-- ═════════════════════════════════════════════
-- 顧客番号: スタッフの直接登録と DB 関数(未ログインの問診経由)からだけ
-- ═════════════════════════════════════════════
create or replace function public.next_customer_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  -- auth.uid() があるのに staff でない = ログインしただけの人が直接呼んでいる
  if auth.uid() is not null and not private.is_any_staff() then
    raise exception 'not_staff' using errcode = 'P0001';
  end if;
  n := nextval('public.customer_code_seq');
  return 'P' || lpad(n::text, greatest(3, length(n::text)), '0');
end;
$$;

-- ═════════════════════════════════════════════
-- 顧客: スタッフが変えてよい列だけ
-- ═════════════════════════════════════════════
revoke insert, update on public.customers from authenticated;
grant insert (name, furigana, phone_normalized, email, birth_date, lang, how_found, address, notes)
  on public.customers to authenticated;
grant update (name, furigana, phone_normalized, email, birth_date, lang, how_found, address, notes, status)
  on public.customers to authenticated;

-- ═════════════════════════════════════════════
-- 関数の実行権限: 既定で閉じ、使うものだけ開ける
--  (Supabase は public の関数に anon / authenticated の実行権限を直接付けるため、明示的に外す)
-- ═════════════════════════════════════════════
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function public.public_store(uuid), public.submit_questionnaire(jsonb) to anon, authenticated;
grant execute on function public.record_visit(jsonb), public.void_visit(jsonb), public.get_patient_card(uuid, uuid),
                          public.next_customer_code(), public.normalize_phone(text) to authenticated;
grant execute on function public.expire_credits(date) to service_role;
-- 予約(一時停止中)は anon / authenticated のどちらからも呼べない

-- ═════════════════════════════════════════════
-- 失効処理の定期実行(Supabase の pg_cron。テスト用 PGlite では飛ばす)
-- ═════════════════════════════════════════════
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- 毎日 00:05(日本時間)= 15:05 UTC
    perform cron.schedule('lbc-expire-credits', '5 15 * * *', 'select public.expire_credits()');
  end if;
end;
$$;
