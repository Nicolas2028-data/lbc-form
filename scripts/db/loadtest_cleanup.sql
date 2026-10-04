-- 負荷テストの架空データ(「ZZ負荷テスト」で始まる患者)をすべて消す。テスト環境専用
begin;
create temp table _zz on commit drop as select id from public.customers where name like 'ZZ負荷テスト %';
delete from public.credit_allocations a using public.credit_entries e
  where (a.use_id = e.id or a.grant_id = e.id) and e.customer_id in (select id from _zz);
delete from public.credit_entries where customer_id in (select id from _zz);
delete from public.pass_uses where pass_id in (select id from public.passes where customer_id in (select id from _zz));
delete from public.passes where customer_id in (select id from _zz);
delete from public.sales where customer_id in (select id from _zz);
delete from public.visits where customer_id in (select id from _zz);
delete from public.customer_consents where customer_id in (select id from _zz);
delete from public.audit_log where table_name = 'customers' and row_id in (select id from _zz);
delete from public.customers where id in (select id from _zz);
commit;
select (select count(*) from public.customers) as customers, (select count(*) from public.visits) as visits;
