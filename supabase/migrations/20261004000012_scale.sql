-- データが増えても速いままにする(2026-10-04 負荷テストで発見: 患者 3,900 人・来院 21,000 件)
--  1. 患者一覧が 1,000 人で切れていた(Supabase の API は 1 回 1,000 行まで)→ 検索は DB で行い、一致した人だけ返す
--  2. ダッシュボードの月別集計が 2.7 秒(全期間の来院から毎回計算)→ 直近の月だけ計算し、
--     初回来院日は customers.first_visit_date(来店の追加・取消で自動更新、migration 0004)を使う

-- 検索用のキー: 空白を除き、小文字、カタカナ → ひらがな
create or replace function private.search_key(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(lower(regexp_replace(coalesce(s, ''), '[\s　\-]+', '', 'g')),
    'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴ',
    'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔ');
$$;

-- 患者検索(スタッフ用)。RLS がそのまま効くよう security invoker(既定)
--  q が空なら、最近来院・登録した順に返す
create or replace function public.search_customers(p_q text default '', p_limit integer default 50)
returns table (id uuid, code text, name text, furigana text, phone_normalized text, status text, lang text, last_visit date)
language sql
stable
set search_path = ''
as $$
  with k as (select private.search_key(p_q) as key, regexp_replace(coalesce(p_q, ''), '\D', '', 'g') as digits)
  select c.id, c.code, c.name, c.furigana, c.phone_normalized, c.status, c.lang,
         (select max(v.visit_date) from public.visits v where v.customer_id = c.id and v.status = 'recorded') as last_visit
  from public.customers c, k
  where c.status = 'active'
    and (k.key = ''
         or private.search_key(c.name) like '%' || k.key || '%'
         or private.search_key(c.furigana) like '%' || k.key || '%'
         or lower(c.code) like '%' || k.key || '%'
         or (length(k.digits) >= 3 and c.phone_normalized like '%' || k.digits || '%'))
  order by
    -- 完全一致・前方一致を上に
    case when k.key <> '' and (lower(c.code) = k.key or private.search_key(c.name) = k.key) then 0
         when k.key <> '' and private.search_key(c.name) like k.key || '%' then 1 else 2 end,
    greatest(c.first_visit_date::timestamptz, c.updated_at) desc nulls last,
    c.code
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- 月別集計(直近 p_months か月、自店舗)
create or replace function public.get_monthly_stats(p_months integer default 12, p_store uuid default null)
returns table (store_id uuid, month date, visits integer, new_customers integer, sales_total integer, unpaid_total integer, avg_per_visit integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff public.staff;
  v_from  date;
begin
  v_staff := private.current_staff(p_store);
  v_from := (date_trunc('month', private.store_today(v_staff.store_id)) - make_interval(months => greatest(p_months, 1) - 1))::date;
  return query
  with months as (
    select generate_series(v_from, private.store_today(v_staff.store_id), interval '1 month')::date as month
  ),
  va as (
    select date_trunc('month', v.visit_date)::date as month,
           count(*) filter (where v.attended) as visits,
           count(distinct v.customer_id) filter (where v.attended and v.visit_date = c.first_visit_date) as new_customers
    from public.visits v join public.customers c on c.id = v.customer_id
    where v.store_id = v_staff.store_id and v.status = 'recorded' and v.visit_date >= v_from
    group by 1
  ),
  sa as (
    select date_trunc('month', s.occurred_on)::date as month,
           coalesce(sum(s.amount) filter (where s.method <> 'unpaid'), 0) as sales_total,
           coalesce(sum(s.amount) filter (where s.method = 'unpaid'), 0) as unpaid_total
    from public.sales s
    where s.store_id = v_staff.store_id and s.occurred_on >= v_from
    group by 1
  )
  select v_staff.store_id, m.month,
         coalesce(va.visits, 0)::integer, coalesce(va.new_customers, 0)::integer,
         coalesce(sa.sales_total, 0)::integer, coalesce(sa.unpaid_total, 0)::integer,
         case when coalesce(va.visits, 0) > 0 then round(coalesce(sa.sales_total, 0)::numeric / va.visits)::integer end
  from months m
  left join va on va.month = m.month
  left join sa on sa.month = m.month
  order by m.month desc;
end;
$$;

create index if not exists sales_store_occurred_idx on public.sales (store_id, occurred_on);
create index if not exists visits_store_date_status_idx on public.visits (store_id, visit_date) where status = 'recorded';

revoke execute on function public.search_customers(text, integer), public.get_monthly_stats(integer, uuid) from public, anon;
grant execute on function public.search_customers(text, integer), public.get_monthly_stats(integer, uuid) to authenticated;
