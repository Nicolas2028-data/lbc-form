-- カルテ(0013)のレビュー修正(2026-10-04)
--  1. 受付: 記録済みの人を受付し直すと「未記録」が消えない行ができていた → 患者の行をロックし、
--     今日の受付(未記録、または取消された記録に付いていたもの)があればそれを使い回す。
--     記録済みの人は「同じ日の 2 回目」と明示したときだけ受付できる。「前回から変化」は受付 ID を指定して変える
--  2. 「前回から変化」を受付から記録へ写す処理をやめる(画面で選んだ値をそのまま記録する。
--     画面で外したのに受付の値が入ってしまっていた)。画面は受付の値を初期値にする
--  3. 今日の一覧: 取消された記録を出すかどうかは「受付が新しい記録に付け替わった」場合だけ隠す
--  4. 問診票からの自動受付: 移行した過去の問診では受付しない。取消後の再記録待ちの受付があれば作らない
--  5. 写真の保存場所の判定を UUID の正しい書式に限定する

-- ── 1. 受付 ──
create or replace function public.checkin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff    public.staff := private.current_staff(nullif(p->>'store_id', '')::uuid);
  v_customer uuid := nullif(p->>'customer_id', '')::uuid;
  v_ck_id    uuid := nullif(p->>'checkin_id', '')::uuid;
  v_change   text := nullif(p->>'change_from_last', '');
  v_second   boolean := coalesce((p->>'second_visit')::boolean, false);
  v_today    date := private.store_today(v_staff.store_id);
  v_id       uuid;
begin
  if v_change is not null and v_change not in ('none', 'changed') then
    raise exception 'invalid_change' using errcode = 'P0001';
  end if;

  -- 受付 ID を指定: その受付の「前回から変化」だけ変える(記録が付いたあとは変えない)
  if v_ck_id is not null then
    update public.checkins c set change_from_last = v_change
    where c.id = v_ck_id and c.store_id = v_staff.store_id and c.cancelled_at is null
      and (c.visit_id is null or exists (select 1 from public.visits v where v.id = c.visit_id and v.status = 'voided'))
    returning c.id into v_id;
    if v_id is null then
      raise exception 'checkin_not_found' using errcode = 'P0001';
    end if;
    return jsonb_build_object('id', v_id, 'existing', true);
  end if;

  -- record_visit と同じ順で患者の行をロック(記録と受付が同時に来ても、どちらかが先に終わってから進む)
  perform 1 from public.customers c where c.id = v_customer and c.status = 'active' for update;
  if not found then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;

  -- 今日の受付(未記録、または取消された記録に付いていたもの)があれば、それを使う
  select c.id into v_id
  from public.checkins c
  left join public.visits v on v.id = c.visit_id
  where c.store_id = v_staff.store_id and c.customer_id = v_customer and c.checkin_date = v_today
    and c.cancelled_at is null and (c.visit_id is null or v.status = 'voided')
  order by (c.visit_id is null) desc, c.created_at
  limit 1
  for update of c;
  if v_id is not null then
    if v_change is not null then
      update public.checkins set change_from_last = v_change where id = v_id;
    end if;
    return jsonb_build_object('id', v_id, 'existing', true);
  end if;

  -- 今日もう記録がある人は、同じ日の 2 回目と明示したときだけ
  if not v_second and exists (
    select 1 from public.visits v
    where v.store_id = v_staff.store_id and v.customer_id = v_customer and v.visit_date = v_today and v.status = 'recorded') then
    raise exception 'already_recorded_today' using errcode = 'P0001';
  end if;

  insert into public.checkins (store_id, customer_id, checkin_date, source, change_from_last, created_by)
  values (v_staff.store_id, v_customer, v_today, 'staff', v_change, v_staff.id)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'existing', false);
end;
$$;

-- ── 2. 受付の「前回から変化」を記録へ写さない ──
drop trigger visits_take_checkin_change on public.visits;
drop function private.visit_take_checkin_change();

-- ── 4. 問診票からの自動受付 ──
create or replace function private.questionnaire_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := (select (new.submitted_at at time zone s.timezone)::date from public.stores s where s.id = new.store_id);
begin
  if new.answers ? 'legacy_images' then   -- 移行した過去の問診
    return null;
  end if;
  if v_date = private.store_today(new.store_id)
     and not exists (select 1 from public.visits v
                     where v.customer_id = new.customer_id and v.store_id = new.store_id
                       and v.visit_date = v_date and v.status = 'recorded')
     and not exists (select 1 from public.checkins c left join public.visits v on v.id = c.visit_id
                     where c.store_id = new.store_id and c.customer_id = new.customer_id and c.checkin_date = v_date
                       and c.cancelled_at is null and (c.visit_id is null or v.status = 'voided')) then
    insert into public.checkins (store_id, customer_id, checkin_date, source)
    values (new.store_id, new.customer_id, v_date, 'questionnaire')
    on conflict (store_id, customer_id, checkin_date) where visit_id is null and cancelled_at is null do nothing;
  end if;
  return null;
end;
$$;

-- ── 3. 今日の一覧 ──
create or replace function public.get_day(p_date date default null, p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff public.staff := private.current_staff(p_store);
  v_date  date := coalesce(p_date, private.store_today(v_staff.store_id));
  v_rows  jsonb;
begin
  with ck as (
    select c.* from public.checkins c
    where c.store_id = v_staff.store_id and c.checkin_date = v_date and c.cancelled_at is null
  ),
  items as (
    select ck.id as checkin_id, ck.customer_id, ck.source, ck.created_at, ck.visit_id,
           coalesce(v.change_from_last, ck.change_from_last) as change_from_last
    from ck left join public.visits v on v.id = ck.visit_id
    union all
    select null, v.customer_id, null, v.created_at, v.id, v.change_from_last
    from public.visits v
    where v.store_id = v_staff.store_id and v.visit_date = v_date
      and not exists (select 1 from ck where ck.visit_id = v.id)
      -- 取消して記録し直した前の記録は出さない(受付が新しい記録に付け替わっている)
      and not (v.status = 'voided' and exists (
        select 1 from ck join public.visits nv on nv.id = ck.visit_id
        where ck.customer_id = v.customer_id and nv.created_at > v.created_at))
  )
  select coalesce(jsonb_agg(row_data order by sort_key, created_at), '[]'::jsonb) into v_rows
  from (
    select
      case when v.id is null then 0 when v.status = 'voided' then 2 else 1 end as sort_key,
      i.created_at,
      jsonb_build_object(
        'checkin_id', i.checkin_id,
        'source', i.source,
        'at', i.created_at,
        'change_from_last', i.change_from_last,
        'state', case when v.id is null then 'waiting' when v.status = 'voided' then 'voided'
                      when not v.attended then 'no_show' else 'done' end,
        'customer', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'furigana', c.furigana, 'lang', c.lang),
        'is_first', (c.first_visit_date is null or c.first_visit_date = v_date),
        'visit', case when v.id is null then null else jsonb_build_object(
          'id', v.id, 'menu_id', v.menu_id, 'attended', v.attended, 'status', v.status,
          'total', coalesce((select sum(s.amount) from public.sales s where s.visit_id = v.id), 0),
          'unpaid', exists (select 1 from public.sales s where s.visit_id = v.id and s.method = 'unpaid' and s.kind = 'sale'))
        end,
        'notes', (select count(*) from public.chart_notes n where n.visit_id = v.id and n.deleted_at is null),
        'photos', (select count(*) from public.chart_photos ph where ph.visit_id = v.id and ph.deleted_at is null)
      ) as row_data
    from items i
    join public.customers c on c.id = i.customer_id
    left join public.visits v on v.id = i.visit_id
  ) x;
  return jsonb_build_object('date', v_date, 'today', private.store_today(v_staff.store_id), 'items', v_rows);
end;
$$;

-- ── 5. 写真の保存場所(UUID の正しい書式だけ) ──
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'drop policy if exists chart_staff_upload on storage.objects';
    execute 'drop policy if exists chart_staff_read on storage.objects';
    execute $p$
      create policy chart_staff_upload on storage.objects for insert to authenticated
      with check (
        bucket_id = 'chart'
        and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
                 then private.is_staff_of(split_part(name, '/', 1)::uuid) else false end
      )
    $p$;
    execute $p$
      create policy chart_staff_read on storage.objects for select to authenticated
      using (
        bucket_id = 'chart'
        and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                 then private.is_staff_of(split_part(name, '/', 1)::uuid) else false end
      )
    $p$;
  end if;
end;
$$;
