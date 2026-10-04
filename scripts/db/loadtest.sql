-- 負荷テスト用の架空データ(名前は「ZZ負荷テスト」で始まる)。テスト環境専用。
-- 使い方: __N__ を作りたい患者数に置き換えて実行。消すときは loadtest_cleanup.sql
-- 患者ごとに過去 1 年で 1〜10 回の来院と売上、3 人に 1 人にクレジット(付与・使用)、5 人に 1 人に月2回プラン
do $$
declare
  v_n      integer := __N__;
  v_store  uuid := '00000000-0000-4000-8000-000000000001';
  v_staff  uuid := (select id from public.staff where store_id = '00000000-0000-4000-8000-000000000001' order by role limit 1);
  v_menus  uuid[] := (select array_agg(id) from public.menus where store_id = '00000000-0000-4000-8000-000000000001' and active);
  v_prod   uuid := (select id from public.products where store_id = '00000000-0000-4000-8000-000000000001' and code = 'monthly2');
  c        uuid;
  i        integer;
  k        integer;
  v_visits integer;
  d        date;
  v_visit  uuid;
  m        uuid;
  price    integer;
  g        uuid;
  u        uuid;
  p        uuid;
begin
  for i in 1..v_n loop
    insert into public.customers (name, furigana, phone_normalized, lang)
    values ('ZZ負荷テスト ' || lpad(i::text, 5, '0'), 'ゼットゼット', '0700' || lpad(i::text, 7, '0'),
            (array['ja', 'pt', 'es'])[1 + i % 3])
    returning id into c;
    v_visits := 1 + (i * 7) % 10;
    for k in 1..v_visits loop
      d := current_date - ((v_visits - k) * 30 + (i % 25));
      m := v_menus[1 + (i + k) % cardinality(v_menus)];
      select menus.price into price from public.menus where id = m;
      v_visit := gen_random_uuid();
      insert into public.visits (id, store_id, customer_id, staff_id, visit_date, attended, menu_id, memo, request_id)
      values (v_visit, v_store, c, v_staff, d, true, m, case when k % 3 = 0 then '腰の張りが強い。次回は肩も' end, gen_random_uuid());
      insert into public.sales (store_id, customer_id, visit_id, kind, amount, method, occurred_on)
      values (v_store, c, v_visit, 'sale', price, (array['cash', 'card', 'paypay'])[1 + k % 3], d);
    end loop;
    if i % 3 = 0 then
      insert into public.credit_entries (customer_id, store_id, kind, amount, reason, expires_on, occurred_on)
      values (c, v_store, 'grant', 2000, 'manual', current_date + 200, current_date - 100) returning id into g;
      insert into public.credit_entries (customer_id, store_id, kind, amount, visit_id, occurred_on)
      values (c, v_store, 'use', -500, v_visit, d) returning id into u;
      insert into public.credit_allocations (use_id, grant_id, amount) values (u, g, 500);
    end if;
    if i % 5 = 0 and v_prod is not null then
      insert into public.passes (store_id, customer_id, product_id, total_uses, valid_from, valid_until, visit_id)
      values (v_store, c, v_prod, 2, current_date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date, v_visit)
      returning id into p;
      insert into public.pass_uses (pass_id, visit_id, delta) values (p, v_visit, -1);
    end if;
  end loop;
end;
$$;
select (select count(*) from public.customers) as customers, (select count(*) from public.visits) as visits,
       (select count(*) from public.sales) as sales, (select count(*) from public.credit_entries) as credits;
