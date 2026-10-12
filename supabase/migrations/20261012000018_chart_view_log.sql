-- カルテ閲覧記録(2026-10-12): get_patient_card 呼出しを audit_log に残す(1-11 対応)
-- stable → volatile に変更して audit_log への INSERT を可能にする

create or replace function public.get_patient_card(p_customer uuid, p_store uuid default null)
returns jsonb
language plpgsql
volatile
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

  -- 閲覧ログ
  insert into public.audit_log (actor, action, table_name, row_id, diff)
  values (auth.uid(), 'view:patient_card', 'customers', v_c.id,
          jsonb_build_object('staff_id', v_staff.id, 'store_id', v_staff.store_id));

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
