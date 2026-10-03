-- 初回来院日のずれを修正(2026-10-03 ファズテストで発見)
--  症状: 初回の記録を取り消して別の日に記録し直すと、customers.first_visit_date が古い日付のまま残り、
--        月別集計の「新規」に数えられなかった(record_visit は first_visit_date が空のときしか設定しないため)
--  対策: ①来店の追加・取消のたびに first_visit_date を「取消されていない最初の来院日」で計算し直す
--        ②月別集計の「新規」は来店履歴から直接求め、customers の列に依存しない

create or replace function private.refresh_first_visit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customers c
  set first_visit_date = (
    select min(v.visit_date) from public.visits v
    where v.customer_id = c.id and v.attended and v.status = 'recorded'
  )
  where c.id = new.customer_id
    and c.first_visit_date is distinct from (
      select min(v.visit_date) from public.visits v
      where v.customer_id = c.id and v.attended and v.status = 'recorded'
    );
  return null;
end;
$$;

create trigger visits_refresh_first_visit
  after insert or update of status on public.visits
  for each row execute function private.refresh_first_visit();

-- 既存データの補正
update public.customers c
set first_visit_date = (
  select min(v.visit_date) from public.visits v
  where v.customer_id = c.id and v.attended and v.status = 'recorded'
);

create or replace view public.v_monthly_stats with (security_invoker = true) as
with months as (
  select store_id, date_trunc('month', visit_date)::date as month from public.visits
  union
  select store_id, date_trunc('month', occurred_on)::date from public.sales
),
first_visits as (
  select customer_id, min(visit_date) as first_date
  from public.visits
  where attended and status = 'recorded'
  group by customer_id
),
visit_agg as (
  select v.store_id, date_trunc('month', v.visit_date)::date as month,
         count(*) filter (where v.attended) as visits,
         count(distinct v.customer_id) filter (where v.attended and v.visit_date = f.first_date) as new_customers
  from public.visits v join first_visits f on f.customer_id = v.customer_id
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
