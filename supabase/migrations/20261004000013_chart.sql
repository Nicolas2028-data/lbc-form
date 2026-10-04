-- カルテ(Notion の「施術カルテ」「顧客管理DB」の置き換え, 2026-10-04 Nicolas 判断で Notion から脱却)
--  1. 受付 checkins       : Notion の「本日カルテ作成」ボタンの代わり。来院した人を当日の一覧に「未記録」で出し、
--                           施術記録が付くと自動で完了になる。初回の問診票を送ると自動で受付される
--  2. カルテメモ chart_notes: 来院ごと・患者ごとの自由記述(Notion のページ本文の代わり)。書き換え前の内容を残す
--  3. カルテ写真 chart_photos: 写真の添付(Storage 'chart'、非公開)。消しても記録は残す(論理削除)
--  4. get_day / list_visits: 今日の一覧・カルテ一覧(Notion のデータベースビューの代わり)

-- ── 1. 受付 ──
create table public.checkins (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores(id),
  customer_id       uuid not null references public.customers(id),
  checkin_date      date not null,
  source            text not null default 'staff' check (source in ('staff', 'questionnaire')),
  change_from_last  text check (change_from_last in ('none', 'changed')),
  visit_id          uuid unique references public.visits(id),
  cancelled_at      timestamptz,
  created_by        uuid references public.staff(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- 同じ人・同じ日に「未記録」の受付は 1 件まで(二度押ししても増えない)
create unique index checkins_one_open on public.checkins (store_id, customer_id, checkin_date)
  where visit_id is null and cancelled_at is null;
create index checkins_store_date_idx on public.checkins (store_id, checkin_date);
create index checkins_customer_idx on public.checkins (customer_id);
create trigger checkins_touch before update on public.checkins
  for each row execute function private.touch_updated_at();

alter table public.checkins enable row level security;
create policy checkins_staff_select on public.checkins for select to authenticated
  using (private.is_staff_of(store_id));
revoke all on public.checkins from anon, authenticated;
grant select on public.checkins to authenticated;

-- 受付する(すでに未記録の受付があれば、それを返す。「前回から変化」は後から押し直せる)
create or replace function public.checkin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff    public.staff := private.current_staff(nullif(p->>'store_id', '')::uuid);
  v_customer uuid := nullif(p->>'customer_id', '')::uuid;
  v_change   text := nullif(p->>'change_from_last', '');
  v_today    date := private.store_today(v_staff.store_id);
  v_id       uuid;
  v_existing boolean;
begin
  if v_change is not null and v_change not in ('none', 'changed') then
    raise exception 'invalid_change' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.customers c where c.id = v_customer and c.status = 'active') then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;
  insert into public.checkins (store_id, customer_id, checkin_date, source, change_from_last, created_by)
  values (v_staff.store_id, v_customer, v_today, 'staff', v_change, v_staff.id)
  on conflict (store_id, customer_id, checkin_date) where visit_id is null and cancelled_at is null
  do update set change_from_last = coalesce(excluded.change_from_last, public.checkins.change_from_last)
  returning id, (xmax <> 0) into v_id, v_existing;
  return jsonb_build_object('id', v_id, 'existing', v_existing);
end;
$$;

-- 受付の取消(まだ記録が付いていないものだけ。間違えて受付した人を一覧から消す)
create or replace function public.cancel_checkin(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.checkins;
begin
  select * into v_row from public.checkins c where c.id = nullif(p->>'checkin_id', '')::uuid for update;
  if v_row.id is null or not private.is_staff_of(v_row.store_id) then
    raise exception 'checkin_not_found' using errcode = 'P0001';
  end if;
  if v_row.visit_id is not null then
    raise exception 'checkin_already_recorded' using errcode = 'P0001';
  end if;
  update public.checkins set cancelled_at = coalesce(cancelled_at, now()) where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'cancelled', true);
end;
$$;

-- 施術記録が付いたら、その日の受付を「完了」にする。
--  「前回から変化」を記録で選ばなかったときは、受付で押したものを使う。
--  取消して記録し直した場合は、取消された記録に付いていた受付を新しい記録に付け替える(一覧で 1 行のまま)
create or replace function private.visit_take_checkin_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.change_from_last is null then
    select c.change_from_last into new.change_from_last
    from public.checkins c
    where c.store_id = new.store_id and c.customer_id = new.customer_id and c.checkin_date = new.visit_date
      and c.visit_id is null and c.cancelled_at is null
    order by c.created_at limit 1;
  end if;
  return new;
end;
$$;

create or replace function private.visit_link_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
  from public.checkins c
  left join public.visits pv on pv.id = c.visit_id
  where c.store_id = new.store_id and c.customer_id = new.customer_id and c.checkin_date = new.visit_date
    and c.cancelled_at is null
    and (c.visit_id is null or pv.status = 'voided')
  order by (c.visit_id is null) desc, c.created_at
  limit 1
  for update of c;
  if v_id is not null then
    update public.checkins set visit_id = new.id where id = v_id;
  end if;
  return null;
end;
$$;

create trigger visits_take_checkin_change before insert on public.visits
  for each row execute function private.visit_take_checkin_change();
create trigger visits_link_checkin after insert on public.visits
  for each row execute function private.visit_link_checkin();

-- 問診票(当日の送信)が届いたら自動で受付する。移行などで過去の問診を入れたときは受付しない
create or replace function private.questionnaire_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := (select (new.submitted_at at time zone s.timezone)::date from public.stores s where s.id = new.store_id);
begin
  if v_date = private.store_today(new.store_id)
     and not exists (select 1 from public.visits v
                     where v.customer_id = new.customer_id and v.store_id = new.store_id
                       and v.visit_date = v_date and v.status = 'recorded') then
    insert into public.checkins (store_id, customer_id, checkin_date, source)
    values (new.store_id, new.customer_id, v_date, 'questionnaire')
    on conflict (store_id, customer_id, checkin_date) where visit_id is null and cancelled_at is null do nothing;
  end if;
  return null;
end;
$$;

create trigger questionnaires_checkin after insert on public.questionnaires
  for each row execute function private.questionnaire_checkin();

-- ── 2. カルテメモ ──
create table public.chart_notes (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id),
  customer_id uuid not null references public.customers(id),
  visit_id    uuid references public.visits(id),          -- null = 患者全体のメモ(注意事項など)
  body        text not null check (length(btrim(body)) between 1 and 20000),
  pinned      boolean not null default false,             -- 注意事項として記録画面の上に常に出す
  created_by  uuid references public.staff(id),
  updated_by  uuid references public.staff(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index chart_notes_customer_idx on public.chart_notes (customer_id, created_at desc);
create index chart_notes_visit_idx on public.chart_notes (visit_id);
create index chart_notes_store_idx on public.chart_notes (store_id);
create index chart_notes_created_by_idx on public.chart_notes (created_by);
create index chart_notes_updated_by_idx on public.chart_notes (updated_by);

-- 書き換え・削除の前の内容(誰がいつ何を変えたか後から確かめられるように。スタッフからは直接見えない)
create table private.chart_note_revisions (
  id          bigint generated always as identity primary key,
  note_id     uuid not null references public.chart_notes(id),
  body        text not null,
  pinned      boolean not null,
  deleted_at  timestamptz,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index on private.chart_note_revisions (note_id);

-- 書いた人・直した人を自動で入れ、変えてはいけない項目(患者・来院・店舗・作成者)を守る
create or replace function private.chart_note_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff uuid := (select s.id from public.staff s
                   where s.user_id = auth.uid() and s.store_id = new.store_id and s.active);
begin
  if tg_op = 'INSERT' then
    if new.visit_id is not null and not exists (
      select 1 from public.visits v where v.id = new.visit_id and v.customer_id = new.customer_id and v.store_id = new.store_id) then
      raise exception 'visit_mismatch' using errcode = 'P0001';
    end if;
    new.created_by := v_staff;
    new.updated_by := v_staff;
    new.created_at := now();
    new.deleted_at := null;
  else
    if new.store_id <> old.store_id or new.customer_id <> old.customer_id
       or new.visit_id is distinct from old.visit_id or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'chart_note_immutable' using errcode = 'P0001';
    end if;
    if old.deleted_at is not null then
      raise exception 'chart_note_deleted' using errcode = 'P0001';
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();   -- 消した時刻はサーバーの時計で
    end if;
    if new.body is distinct from old.body or new.pinned is distinct from old.pinned or new.deleted_at is distinct from old.deleted_at then
      insert into private.chart_note_revisions (note_id, body, pinned, deleted_at, changed_by)
      values (old.id, old.body, old.pinned, old.deleted_at, v_staff);
    end if;
    new.updated_by := v_staff;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger chart_notes_guard before insert or update on public.chart_notes
  for each row execute function private.chart_note_guard();

alter table public.chart_notes enable row level security;
create policy chart_notes_staff_select on public.chart_notes for select to authenticated
  using (private.is_staff_of(store_id));
create policy chart_notes_staff_insert on public.chart_notes for insert to authenticated
  with check (private.is_staff_of(store_id));
create policy chart_notes_staff_update on public.chart_notes for update to authenticated
  using (private.is_staff_of(store_id)) with check (private.is_staff_of(store_id));
revoke all on public.chart_notes from anon, authenticated;
grant select on public.chart_notes to authenticated;
grant insert (store_id, customer_id, visit_id, body, pinned) on public.chart_notes to authenticated;
grant update (body, pinned, deleted_at) on public.chart_notes to authenticated;
alter table private.chart_note_revisions enable row level security;
revoke all on private.chart_note_revisions from anon, authenticated;

-- ── 3. カルテ写真 ──
create table public.chart_photos (
  id          uuid primary key,                            -- 画面で作る(先に Storage に上げてから行を作るため)
  store_id    uuid not null references public.stores(id),
  customer_id uuid not null references public.customers(id),
  visit_id    uuid references public.visits(id),
  path        text not null unique,
  caption     text check (caption is null or length(caption) <= 500),
  created_by  uuid references public.staff(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references public.staff(id),
  -- 保存場所は <店舗>/<患者>/<写真ID>.<拡張子> に固定(ほかの患者のフォルダを指せないように)
  check (path ~ ('^' || store_id::text || '/' || customer_id::text || '/' || id::text || '\.(jpg|png|webp)$'))
);
create index chart_photos_customer_idx on public.chart_photos (customer_id, created_at desc);
create index chart_photos_visit_idx on public.chart_photos (visit_id);
create index chart_photos_store_idx on public.chart_photos (store_id);
create index chart_photos_created_by_idx on public.chart_photos (created_by);
create index chart_photos_deleted_by_idx on public.chart_photos (deleted_by);

create or replace function private.chart_photo_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff uuid := (select s.id from public.staff s
                   where s.user_id = auth.uid() and s.store_id = new.store_id and s.active);
begin
  if tg_op = 'INSERT' then
    if new.visit_id is not null and not exists (
      select 1 from public.visits v where v.id = new.visit_id and v.customer_id = new.customer_id and v.store_id = new.store_id) then
      raise exception 'visit_mismatch' using errcode = 'P0001';
    end if;
    new.created_by := v_staff;
    new.created_at := now();
    new.deleted_at := null;
    new.deleted_by := null;
  else
    if new.store_id <> old.store_id or new.customer_id <> old.customer_id or new.path <> old.path
       or new.visit_id is distinct from old.visit_id or new.created_by is distinct from old.created_by then
      raise exception 'chart_photo_immutable' using errcode = 'P0001';
    end if;
    if old.deleted_at is not null then
      raise exception 'chart_photo_deleted' using errcode = 'P0001';
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();
      new.deleted_by := v_staff;
    end if;
  end if;
  return new;
end;
$$;

create trigger chart_photos_guard before insert or update on public.chart_photos
  for each row execute function private.chart_photo_guard();

alter table public.chart_photos enable row level security;
create policy chart_photos_staff_select on public.chart_photos for select to authenticated
  using (private.is_staff_of(store_id));
create policy chart_photos_staff_insert on public.chart_photos for insert to authenticated
  with check (private.is_staff_of(store_id));
create policy chart_photos_staff_update on public.chart_photos for update to authenticated
  using (private.is_staff_of(store_id)) with check (private.is_staff_of(store_id));
revoke all on public.chart_photos from anon, authenticated;
grant select on public.chart_photos to authenticated;
grant insert (id, store_id, customer_id, visit_id, path, caption) on public.chart_photos to authenticated;
grant update (caption, deleted_at) on public.chart_photos to authenticated;

-- Storage(Supabase 環境のみ。PGlite には storage スキーマが無いので飛ばす)
--  スタッフが自分の店舗のフォルダにだけ上げられ、見られる。上書き・削除は不可
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('chart', 'chart', false, 5 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;
    execute $p$
      create policy chart_staff_upload on storage.objects for insert to authenticated
      with check (
        bucket_id = 'chart'
        and case when name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
                 then private.is_staff_of(split_part(name, '/', 1)::uuid) else false end
      )
    $p$;
    execute $p$
      create policy chart_staff_read on storage.objects for select to authenticated
      using (
        bucket_id = 'chart'
        and case when name ~ '^[0-9a-f-]{36}/' then private.is_staff_of(split_part(name, '/', 1)::uuid) else false end
      )
    $p$;
  end if;
end;
$$;

-- ── 4. 一覧 ──
-- 今日(または指定日)の来院一覧: 受付した人と記録された人。未記録を上に
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
      -- 取消して記録し直した前の記録は、受付の行(新しい記録に付け替え済み)にまとめて出さない
      and not (v.status = 'voided' and exists (select 1 from ck where ck.customer_id = v.customer_id))
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

-- カルテ一覧(期間・キーワード)。キーワードは患者名・番号・施術メモ・カルテメモから探す
create or replace function public.list_visits(p_from date, p_to date, p_q text default '', p_limit integer default 200,
                                              p_store uuid default null)
returns table (
  id uuid, visit_date date, customer_id uuid, customer_code text, customer_name text, menu_id uuid,
  attended boolean, status text, change_from_last text, total integer, unpaid boolean, memo text,
  note_excerpt text, notes integer, photos integer, days_since_prev integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff public.staff := private.current_staff(p_store);
  v_key   text := private.search_key(p_q);
  v_like  text := '%' || replace(replace(replace(coalesce(trim(p_q), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;
  return query
  select v.id, v.visit_date, c.id, c.code, c.name, v.menu_id, v.attended, v.status, v.change_from_last,
         coalesce((select sum(s.amount) from public.sales s where s.visit_id = v.id), 0)::integer,
         exists (select 1 from public.sales s where s.visit_id = v.id and s.method = 'unpaid' and s.kind = 'sale'),
         coalesce(v.memo, v.no_show_reason),
         (select left(n.body, 140) from public.chart_notes n
          where n.visit_id = v.id and n.deleted_at is null order by n.created_at desc limit 1),
         (select count(*) from public.chart_notes n where n.visit_id = v.id and n.deleted_at is null)::integer,
         (select count(*) from public.chart_photos ph where ph.visit_id = v.id and ph.deleted_at is null)::integer,
         (v.visit_date - (select max(v2.visit_date) from public.visits v2
                          where v2.customer_id = v.customer_id and v2.status = 'recorded' and v2.attended
                            and v2.visit_date < v.visit_date))::integer
  from public.visits v
  join public.customers c on c.id = v.customer_id
  where v.store_id = v_staff.store_id and v.visit_date between p_from and p_to
    and (v_key = ''
         or private.search_key(c.name) like '%' || v_key || '%'
         or private.search_key(c.furigana) like '%' || v_key || '%'
         or lower(c.code) like '%' || v_key || '%'
         or v.memo ilike v_like
         or exists (select 1 from public.chart_notes n
                    where n.visit_id = v.id and n.deleted_at is null and n.body ilike v_like))
  order by v.visit_date desc, v.created_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

revoke execute on function public.checkin(jsonb), public.cancel_checkin(jsonb), public.get_day(date, uuid),
  public.list_visits(date, date, text, integer, uuid) from public, anon;
grant execute on function public.checkin(jsonb), public.cancel_checkin(jsonb), public.get_day(date, uuid),
  public.list_visits(date, date, text, integer, uuid) to authenticated;
