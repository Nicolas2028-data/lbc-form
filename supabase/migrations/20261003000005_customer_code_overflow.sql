-- 顧客番号の桁あふれを修正(2026-10-03 ファズテストで発見)
--  症状: lpad(n, 3) は 4 桁以上を切り詰めるため、1000 人目が P100 になり既存番号と重複してエラー
--  対策: 3 桁未満だけゼロ埋めし、それ以上は桁数を伸ばす(P999 → P1000)
create or replace function public.next_customer_code()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'P' || lpad(n::text, greatest(3, length(n::text)), '0')
  from (select nextval('public.customer_code_seq') as n) s;
$$;

alter table public.customers alter column code set default public.next_customer_code();
