-- 同じ患者・同じ日の二重記録を防ぐ(2026-10-03 Nicolas 指摘)
--  画面で「記録する」を 2 回押すと、request_id が別になるため 2 件記録できてしまっていた。
--  当日すでに記録(取消済みを除く)がある患者には、allow_same_day = true のときだけ記録を許す。
--  record_visit 全体を差し替える(20261003000002 からの変更点は上記チェックのみ)

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

  -- 同じ患者・同じ日の記録は、明示的に「もう 1 件」と指定されたときだけ受け付ける(二重記録防止)
  if not v_same_day and exists (
    select 1 from public.visits x
    where x.customer_id = v_customer.id and x.visit_date = v_today and x.status = 'recorded'
  ) then
    raise exception 'already_recorded_today' using errcode = 'P0001';
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
