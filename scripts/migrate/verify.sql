-- 移行後の照合: 新基盤の側で build.mjs の expected.json と同じ形の数字を計算する(個人情報なし、患者番号のみ)
select jsonb_build_object(
  'customers', jsonb_build_object(
    'total', (select count(*) from public.customers),
    'active', (select count(*) from public.customers where status = 'active')),
  'visits', jsonb_build_object(
    'attended', (select count(*) from public.visits where attended and status = 'recorded'),
    'no_show', (select count(*) from public.visits where not attended),
    'voided', (select count(*) from public.visits where status = 'voided')),
  'visitsByCustomer', coalesce((select jsonb_object_agg(code, n) from (
      select c.code, count(*) as n from public.visits v join public.customers c on c.id = v.customer_id
      where v.attended and v.status = 'recorded' group by c.code) x), '{}'),
  'salesByMonth', coalesce((select jsonb_object_agg(m, s) from (
      select to_char(occurred_on, 'YYYY-MM') as m, sum(amount) as s from public.sales group by 1) x), '{}'),
  'salesTotal', (select coalesce(sum(amount), 0) from public.sales),
  'creditByCustomer', coalesce((select jsonb_object_agg(code, s) from (
      select c.code, sum(e.amount) as s from public.credit_entries e join public.customers c on c.id = e.customer_id group by c.code) x), '{}'),
  'creditAvailableByCustomer', coalesce((select jsonb_object_agg(c.code, private.credit_available(c.id, (now() at time zone 'Asia/Tokyo')::date))
      from public.customers c where exists (select 1 from public.credit_entries e where e.customer_id = c.id)), '{}'),
  'passes', (select count(*) from public.passes),
  'questionnaires', (select count(*) from public.questionnaires),
  'firstVisitByCustomer', coalesce((select jsonb_object_agg(code, first_visit_date) from public.customers where first_visit_date is not null), '{}')
) as verify;
