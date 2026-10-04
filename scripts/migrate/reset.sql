-- テスト環境の業務データ(患者・来店・売上・クレジット・回数券・問診・予約)をすべて消す。
-- 店舗・スタッフ・メニュー・商品・営業時間は残す。**本番では絶対に実行しない**(安全のため、患者が 200 人を超えていたら止まる)
begin;
do $$ begin
  if (select count(*) from public.customers) > 200 then
    raise exception 'customers > 200: this does not look like the test environment. aborted';
  end if;
end $$;
delete from public.credit_allocations;
delete from public.credit_entries;
delete from public.pass_uses;
delete from public.passes;
delete from public.sales;
delete from public.orders;
delete from public.bookings;
delete from public.visits;
delete from public.questionnaires;
delete from public.customer_consents;
delete from public.audit_log;
delete from private.idempotency;
delete from public.customers;
commit;
select 'RESET' as m, (select count(*) from public.customers) as customers, (select count(*) from public.visits) as visits;
