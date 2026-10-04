-- 印刷・Excel 出力の記録(2026-10-04)。個人情報がシステムの外(紙・ファイル)に出るので、誰がいつ何を出したか残す。
--  患者 1 人分(印刷・Excel)はスタッフ全員、全員分(顧客一覧・カルテ一覧)はオーナーだけ
create or replace function public.log_export(p_kind text, p_customer uuid default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff public.staff := private.current_staff(null);
begin
  if p_kind not in ('patient_print', 'patient_xlsx', 'customers_xlsx', 'charts_xlsx') then
    raise exception 'invalid_export' using errcode = 'P0001';
  end if;
  if p_kind in ('customers_xlsx', 'charts_xlsx') and v_staff.role <> 'owner' then
    raise exception 'export_owner_only' using errcode = 'P0001';
  end if;
  if p_kind like 'patient_%' and (p_customer is null or not exists (select 1 from public.customers c where c.id = p_customer)) then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;
  insert into public.audit_log (actor, action, table_name, row_id, diff)
  values ((select auth.uid()), 'export:' || p_kind, 'customers', p_customer,
          jsonb_build_object('staff_id', v_staff.id, 'store_id', v_staff.store_id) || coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke execute on function public.log_export(text, uuid, jsonb) from public, anon;
grant execute on function public.log_export(text, uuid, jsonb) to authenticated;
