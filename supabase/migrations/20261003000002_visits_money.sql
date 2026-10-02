-- LBC Care 新基盤: 来店・お金(売上・クレジット・回数券)
-- 設計: .steering/20261003-platform-rebuild/design.md 2.3 / 2.4 / 2.8 / 3 章
--
-- 業務ルール(現行 GAS handleSubmitTreatmentRecord / SPEC.md 2.3 から引き継ぎ)
--  - 料金はメニュー・商品から DB が決める(画面から来た金額は使わない)
--  - 紹介: 紹介された側は初回来店で ¥1,000 引き。紹介者に ¥1,000 クレジット(1 年有効)、
--          紹介者 1 人あたり最大 3 件。自分自身は紹介者にできない。紹介とクレジット使用は併用不可
--  - クレジット: 有効期限の近い順に消費(FIFO)、付与から 1 年で失効、残高超過の使用は拒否
--  - 月2回プラン = 当月末まで有効な 2 回券(products.validity = 'end_of_month')
--  - 訂正は赤伝(取消行を追加)。スタッフは当日分のみ、owner は過去日も可
--  - 未払い: 売上は金額どおり method='unpaid' で計上(現行は 0 円で記録していたが、未収金として残す)

-- ─────────────────────────────────────────────
-- テーブル
-- ─────────────────────────────────────────────
create table public.visits (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores(id),
  customer_id       uuid not null references public.customers(id),
  staff_id          uuid references public.staff(id),
  visit_date        date not null,
  attended          boolean not null,
  no_show_reason    text,
  menu_id           uuid references public.menus(id),
  change_from_last  text check (change_from_last in ('none', 'changed')),
  memo              text,
  referrer_id       uuid references public.customers(id),
  status            text not null default 'recorded' check (status in ('recorded', 'voided')),
  voided_at         timestamptz,
  void_reason       text,
  request_id        uuid not null unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (attended or (no_show_reason is not null and length(trim(no_show_reason)) > 0)),
  check (not attended or menu_id is not null)
);
create index on public.visits (customer_id, visit_date);
create index on public.visits (store_id, visit_date);

create trigger visits_touch before update on public.visits
  for each row execute function private.touch_updated_at();

create table public.orders (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references public.stores(id),
  customer_id            uuid not null references public.customers(id),
  product_id             uuid not null references public.products(id),
  amount                 integer not null check (amount >= 0),
  status                 text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'cancelled')),
  stripe_session_id      text unique,
  stripe_payment_intent  text unique,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.sales (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id),
  customer_id  uuid not null references public.customers(id),
  visit_id     uuid references public.visits(id),
  order_id     uuid references public.orders(id),
  kind         text not null check (kind in ('sale', 'refund', 'void')),
  amount       integer not null,
  method       text not null check (method in ('cash', 'card', 'paypay', 'stripe', 'unpaid', 'other')),
  breakdown    jsonb not null default '{}'::jsonb,
  reverses_id  uuid unique references public.sales(id),
  occurred_on  date not null,
  created_at   timestamptz not null default now(),
  check ((kind = 'sale' and amount >= 0 and reverses_id is null)
      or (kind in ('refund', 'void') and amount <= 0))
);
create index on public.sales (store_id, occurred_on);
create index on public.sales (visit_id);

create table public.credit_entries (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id),
  store_id     uuid references public.stores(id),
  kind         text not null check (kind in ('grant', 'use', 'expire', 'void')),
  amount       integer not null,
  reason       text,                    -- grant: referral / manual / migration
  expires_on   date,
  visit_id     uuid references public.visits(id),
  reverses_id  uuid references public.credit_entries(id),
  occurred_on  date not null,
  created_at   timestamptz not null default now(),
  check ((kind = 'grant'  and amount > 0 and expires_on is not null)
      or (kind = 'use'    and amount < 0)
      or (kind = 'expire' and amount < 0 and reverses_id is not null)
      or (kind = 'void'   and reverses_id is not null))
);
create index on public.credit_entries (customer_id);
create unique index credit_void_once on public.credit_entries (reverses_id) where kind = 'void';

create table public.passes (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id),
  customer_id  uuid not null references public.customers(id),
  product_id   uuid not null references public.products(id),
  total_uses   integer not null check (total_uses > 0),
  valid_from   date not null,
  valid_until  date not null,
  visit_id     uuid references public.visits(id),     -- 店頭で購入した来店
  order_id     uuid references public.orders(id),     -- オンライン購入
  status       text not null default 'active' check (status in ('active', 'voided')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (valid_until >= valid_from)
);
create index on public.passes (customer_id);

create table public.pass_uses (
  id           uuid primary key default gen_random_uuid(),
  pass_id      uuid not null references public.passes(id),
  visit_id     uuid references public.visits(id),
  delta        integer not null check (delta in (-1, 1)),
  reverses_id  uuid unique references public.pass_uses(id),
  created_at   timestamptz not null default now(),
  check ((delta = -1 and reverses_id is null) or (delta = 1 and reverses_id is not null))
);
create index on public.pass_uses (pass_id);

create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();
create trigger passes_touch before update on public.passes
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────
-- 計算ヘルパー
-- ─────────────────────────────────────────────

-- クレジットのロット(付与ごと)の残り。消費は有効期限の近い順(FIFO)に割り当てる。
-- unassigned: どのロットにも割り当てられなかった消費(付与の取消などで生じる不足分)
create or replace function private.credit_lots(p_customer uuid)
returns table (grant_id uuid, expires_on date, remaining integer, unassigned integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_consumed integer;
  r record;
  v_take integer;
begin
  -- 使用の正味(取消された使用は戻す)
  select coalesce(-sum(e.amount), 0) into v_consumed
  from public.credit_entries e
  where e.customer_id = p_customer
    and (e.kind = 'use'
         or (e.kind = 'void' and exists (select 1 from public.credit_entries u
                                         where u.id = e.reverses_id and u.kind = 'use')));

  for r in
    select g.id, g.expires_on,
           g.amount
             + coalesce((select sum(x.amount) from public.credit_entries x
                         where x.reverses_id = g.id and x.kind in ('expire', 'void')), 0) as lot
    from public.credit_entries g
    where g.customer_id = p_customer and g.kind = 'grant'
    order by g.expires_on, g.created_at, g.id
  loop
    v_take := least(greatest(r.lot, 0), greatest(v_consumed, 0));
    v_consumed := v_consumed - v_take;
    grant_id := r.id;
    expires_on := r.expires_on;
    remaining := greatest(r.lot, 0) - v_take;
    unassigned := 0;
    return next;
  end loop;

  if v_consumed > 0 then
    grant_id := null; expires_on := null; remaining := 0; unassigned := v_consumed;
    return next;
  end if;
end;
$$;

-- 指定日時点で使えるクレジット残高
create or replace function private.credit_available(p_customer uuid, p_as_of date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce(sum(l.remaining) filter (where l.expires_on >= p_as_of), 0)
      - coalesce(sum(l.unassigned), 0),
    0)::integer
  from private.credit_lots(p_customer) l;
$$;

-- 回数券の残り回数
create or replace function private.pass_remaining(p_pass uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select p.total_uses + coalesce((select sum(u.delta) from public.pass_uses u where u.pass_id = p.id), 0)::integer
  from public.passes p where p.id = p_pass;
$$;

create or replace function private.store_today(p_store uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone s.timezone)::date from public.stores s where s.id = p_store;
$$;

-- 現在のユーザーのスタッフ行(店舗指定なしで所属が 1 店舗ならそれ)
create or replace function private.current_staff(p_store uuid)
returns public.staff
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.staff;
  n integer;
begin
  if p_store is not null then
    select * into v from public.staff s
    where s.user_id = auth.uid() and s.store_id = p_store and s.active;
  else
    select count(*) into n from public.staff s where s.user_id = auth.uid() and s.active;
    if n = 1 then
      select * into v from public.staff s where s.user_id = auth.uid() and s.active;
    end if;
  end if;
  if v.id is null then
    raise exception 'not_staff' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

create or replace function private.idem_get(p_request uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select i.result from private.idempotency i where i.request_id = p_request;
$$;

-- ─────────────────────────────────────────────
-- 施術記録
-- ─────────────────────────────────────────────
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
  v_customer  public.customers;
  v_referrer  public.customers;
  v_menu      public.menus;
  v_product   public.products;
  v_pass      public.passes;
  v_attended  boolean := coalesce((p->>'attended')::boolean, true);
  v_reason    text := nullif(trim(coalesce(p->>'no_show_reason', '')), '');
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
  v_new_pass  uuid;
  v_valid_to  date;
  v_ref_count integer;
  v_ref_limit boolean := false;
  v_result    jsonb;
begin
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request);
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  v_staff := private.current_staff(nullif(p->>'store_id', '')::uuid);
  select * into v_store from public.stores where id = v_staff.store_id;
  v_today := private.store_today(v_store.id);

  -- 同じ顧客への同時記録を直列化(残高チェックの競合防止)
  select * into v_customer from public.customers
  where id = (p->>'customer_id')::uuid for update;
  if v_customer.id is null or v_customer.status <> 'active' then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;

  if not v_attended then
    if v_reason is null then
      raise exception 'no_show_reason_required' using errcode = 'P0001';
    end if;
    insert into public.visits (id, store_id, customer_id, staff_id, visit_date, attended,
                               no_show_reason, change_from_last, memo, request_id)
    values (v_visit_id, v_store.id, v_customer.id, v_staff.id, v_today, false,
            v_reason, v_change, v_memo, v_request);
    v_result := jsonb_build_object('visit_id', v_visit_id, 'attended', false, 'total', 0);
    insert into private.idempotency (request_id, fn, result) values (v_request, 'record_visit', v_result);
    return v_result;
  end if;

  -- メニュー
  select * into v_menu from public.menus
  where id = nullif(p->>'menu_id', '')::uuid and store_id = v_store.id and active;
  if v_menu.id is null then
    raise exception 'menu_invalid' using errcode = 'P0001';
  end if;

  -- 回数券の使用
  if v_use_pass is not null and v_buy is not null and v_use_buy then
    raise exception 'pass_conflict' using errcode = 'P0001';
  end if;
  if v_use_pass is not null then
    select * into v_pass from public.passes where id = v_use_pass for update;
    if v_pass.id is null or v_pass.customer_id <> v_customer.id or v_pass.status <> 'active'
       or v_today not between v_pass.valid_from and v_pass.valid_until then
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

  -- 回数券の購入(店頭)
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

  -- 紹介
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

  -- クレジット使用
  if v_credit < 0 then
    raise exception 'credit_invalid' using errcode = 'P0001';
  end if;
  if v_credit > 0 then
    v_available := private.credit_available(v_customer.id, v_today);
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

  -- 書き込み
  insert into public.visits (id, store_id, customer_id, staff_id, visit_date, attended, menu_id,
                             change_from_last, memo, referrer_id, request_id)
  values (v_visit_id, v_store.id, v_customer.id, v_staff.id, v_today, true, v_menu.id,
          v_change, v_memo, v_ref_id, v_request);

  if v_total > 0 then
    insert into public.sales (store_id, customer_id, visit_id, kind, amount, method, breakdown, occurred_on)
    values (v_store.id, v_customer.id, v_visit_id, 'sale', v_total, v_method,
            jsonb_build_object('menu_price', v_menu_chg, 'product_price', v_prod_chg,
                               'referral_discount', v_discount, 'credit_used', v_credit,
                               'menu_code', v_menu.code, 'product_code', v_product.code),
            v_today);
  end if;

  if v_credit > 0 then
    insert into public.credit_entries (customer_id, store_id, kind, amount, visit_id, occurred_on)
    values (v_customer.id, v_store.id, 'use', -v_credit, v_visit_id, v_today);
  end if;

  if v_buy is not null then
    v_valid_to := case v_product.validity
      when 'end_of_month' then (date_trunc('month', v_today) + interval '1 month - 1 day')::date
      else v_today + v_product.valid_days - 1
    end;
    insert into public.passes (store_id, customer_id, product_id, total_uses, valid_from, valid_until, visit_id)
    values (v_store.id, v_customer.id, v_product.id, v_product.uses, v_today, v_valid_to, v_visit_id)
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
              (v_today + interval '1 year')::date, v_visit_id, v_today);
    else
      v_ref_limit := true;
    end if;
  end if;

  if v_customer.first_visit_date is null then
    update public.customers set first_visit_date = v_today where id = v_customer.id;
  end if;

  v_result := jsonb_build_object(
    'visit_id', v_visit_id,
    'attended', true,
    'total', v_total,
    'breakdown', jsonb_build_object('menu_price', v_menu_chg, 'product_price', v_prod_chg,
                                    'referral_discount', v_discount, 'credit_used', v_credit),
    'pass_id', coalesce(v_new_pass, v_use_pass),
    'referral_limit_reached', v_ref_limit,
    'credit_available', private.credit_available(v_customer.id, v_today)
  );
  insert into private.idempotency (request_id, fn, result) values (v_request, 'record_visit', v_result);
  return v_result;
end;
$$;

-- ─────────────────────────────────────────────
-- 施術記録の取消(赤伝)
-- ─────────────────────────────────────────────
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
  v_prev := private.idem_get(v_request);
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;
  if v_reason is null then
    raise exception 'void_reason_required' using errcode = 'P0001';
  end if;

  select * into v_visit from public.visits where id = (p->>'visit_id')::uuid for update;
  if v_visit.id is null then
    raise exception 'visit_not_found' using errcode = 'P0001';
  end if;
  v_staff := private.current_staff(v_visit.store_id);
  if v_visit.status <> 'recorded' then
    raise exception 'already_voided' using errcode = 'P0001';
  end if;
  v_today := private.store_today(v_visit.store_id);
  if v_visit.visit_date <> v_today and v_staff.role <> 'owner' then
    raise exception 'void_past_requires_owner' using errcode = 'P0001';
  end if;

  -- この来店で購入した回数券が、他の来店で使われていたら取消できない
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
  insert into private.idempotency (request_id, fn, result) values (v_request, 'void_visit', v_result);
  return v_result;
end;
$$;

-- ─────────────────────────────────────────────
-- 記録画面用の患者情報
-- ─────────────────────────────────────────────
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
                        where ps.customer_id = v_c.id and ps.status = 'active'
                          and v_today between ps.valid_from and ps.valid_until
                          and private.pass_remaining(ps.id) > 0), '[]'::jsonb),
    'today_visits', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', v.id, 'attended', v.attended, 'menu_id', v.menu_id,
                                 'status', v.status, 'memo', v.memo,
                                 'total', (select coalesce(sum(s.amount), 0) from public.sales s where s.visit_id = v.id))
                                 order by v.created_at)
                              from public.visits v
                              where v.customer_id = v_c.id and v.visit_date = v_today), '[]'::jsonb)
  );
end;
$$;

-- ─────────────────────────────────────────────
-- クレジット失効(cron で毎日実行。service_role のみ)
-- ─────────────────────────────────────────────
create or replace function public.expire_credits(p_as_of date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Tokyo')::date);
  v_cust  uuid;
  l       record;
  n       integer := 0;
begin
  for v_cust in select distinct e.customer_id from public.credit_entries e where e.kind = 'grant' and e.expires_on < v_as_of
  loop
    for l in select * from private.credit_lots(v_cust) x where x.expires_on < v_as_of and x.remaining > 0
    loop
      insert into public.credit_entries (customer_id, kind, amount, reverses_id, occurred_on)
      values (v_cust, 'expire', -l.remaining, l.grant_id, v_as_of);
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$$;

-- ─────────────────────────────────────────────
-- 集計ビュー(ダッシュボード)。security_invoker で呼び出し元の RLS が効く
-- ─────────────────────────────────────────────
create view public.v_monthly_stats with (security_invoker = true) as
with months as (
  select store_id, date_trunc('month', visit_date)::date as month from public.visits
  union
  select store_id, date_trunc('month', occurred_on)::date from public.sales
),
visit_agg as (
  select v.store_id, date_trunc('month', v.visit_date)::date as month,
         count(*) filter (where v.attended) as visits,
         count(distinct v.customer_id) filter (where v.attended and v.visit_date = c.first_visit_date) as new_customers
  from public.visits v join public.customers c on c.id = v.customer_id
  where v.status = 'recorded'
  group by 1, 2
),
sales_agg as (
  select s.store_id, date_trunc('month', s.occurred_on)::date as month,
         coalesce(sum(s.amount) filter (where s.method <> 'unpaid'), 0) as sales_total,
         coalesce(sum(s.amount) filter (where s.method = 'unpaid'), 0) as unpaid_total
  from public.sales s
  group by 1, 2
)
select m.store_id, m.month,
       coalesce(va.visits, 0)::integer        as visits,
       coalesce(va.new_customers, 0)::integer as new_customers,
       coalesce(sa.sales_total, 0)::integer   as sales_total,
       coalesce(sa.unpaid_total, 0)::integer  as unpaid_total,
       case when coalesce(va.visits, 0) > 0
            then round(coalesce(sa.sales_total, 0)::numeric / va.visits)::integer end as avg_per_visit
from months m
left join visit_agg va on va.store_id = m.store_id and va.month = m.month
left join sales_agg sa on sa.store_id = m.store_id and sa.month = m.month;

-- ─────────────────────────────────────────────
-- 権限
-- ─────────────────────────────────────────────
revoke all on public.visits, public.sales, public.credit_entries, public.passes,
              public.pass_uses, public.orders from anon, authenticated;

alter table public.visits         enable row level security;
alter table public.sales          enable row level security;
alter table public.credit_entries enable row level security;
alter table public.passes         enable row level security;
alter table public.pass_uses      enable row level security;
alter table public.orders         enable row level security;

-- 読み取りのみ許可(書き込みは record_visit / void_visit 経由)
grant select on public.visits, public.sales, public.credit_entries, public.passes,
                public.pass_uses, public.orders to authenticated;
grant select on public.v_monthly_stats to authenticated;

create policy visits_staff_select on public.visits for select to authenticated
  using (private.is_staff_of(store_id));
create policy sales_staff_select on public.sales for select to authenticated
  using (private.is_staff_of(store_id));
create policy credit_staff_select on public.credit_entries for select to authenticated
  using (private.is_any_staff());
create policy passes_staff_select on public.passes for select to authenticated
  using (private.is_staff_of(store_id));
create policy pass_uses_staff_select on public.pass_uses for select to authenticated
  using (exists (select 1 from public.passes ps where ps.id = pass_id and private.is_staff_of(ps.store_id)));
create policy orders_staff_select on public.orders for select to authenticated
  using (private.is_staff_of(store_id));

revoke all on function public.record_visit(jsonb), public.void_visit(jsonb),
                       public.get_patient_card(uuid, uuid), public.expire_credits(date) from public, anon;
grant execute on function public.record_visit(jsonb), public.void_visit(jsonb),
                          public.get_patient_card(uuid, uuid) to authenticated;
revoke all on function public.expire_credits(date) from authenticated;
grant execute on function public.expire_credits(date) to service_role;
