-- 予約(予約枠・空き時間・予約作成・キャンセル)
-- 設計: design.md 2.6 / 3 章 / 8.1 N1
--
--  - 勤務枠 = 曜日ごとの通常枠(staff_schedules)+ 日付ごとの休み/臨時枠(schedule_exceptions)
--  - 空き時間 = 勤務枠 − 予約済み −(現在 + 受付締切)より前。刻みは店舗設定(既定 30 分)
--  - 二重予約は DB の排他制約が最後の砦(同じスタッフの時間帯が重なる confirmed は入らない)
--  - お客様はログイン不要で予約できる。照合は問診票と同じ(電話番号 + 氏名、なければ新規登録)
--  - お客様のキャンセルは予約時に渡す cancel_token で(締切: 店舗設定、既定 3 時間前まで)
--  店舗設定 stores.settings: slot_minutes(30), lead_minutes(60), cancel_hours(3), max_days_ahead(60), max_future_per_phone(3)

create table public.staff_schedules (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id),
  staff_id    uuid not null references public.staff(id),
  weekday     smallint not null check (weekday between 0 and 6),   -- 0 = 日曜
  start_time  time not null,
  end_time    time not null,
  created_at  timestamptz not null default now(),
  check (end_time > start_time)
);
create index on public.staff_schedules (store_id, weekday);

create table public.schedule_exceptions (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id),
  staff_id    uuid not null references public.staff(id),
  date        date not null,
  kind        text not null check (kind in ('off', 'extra')),
  start_time  time,          -- off で null = 終日休み
  end_time    time,
  note        text,
  created_at  timestamptz not null default now(),
  check ((start_time is null and end_time is null and kind = 'off')
      or (start_time is not null and end_time is not null and end_time > start_time))
);
create index on public.schedule_exceptions (store_id, date);

create table public.bookings (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id),
  staff_id      uuid not null references public.staff(id),
  customer_id   uuid not null references public.customers(id),
  menu_id       uuid not null references public.menus(id),
  period        tstzrange not null,
  status        text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  source        text not null check (source in ('web', 'staff', 'mypage')),
  note          text,
  cancel_token  uuid not null default gen_random_uuid() unique,
  cancelled_at  timestamptz,
  cancelled_by  text check (cancelled_by in ('customer', 'staff')),
  request_id    uuid not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (not isempty(period) and lower_inc(period) and not upper_inc(period)),
  constraint bookings_no_overlap exclude using gist (staff_id with =, period with &&) where (status = 'confirmed')
);
create index on public.bookings (store_id, lower(period));
create index on public.bookings (customer_id);

create trigger bookings_touch before update on public.bookings
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────
-- 設定値
-- ─────────────────────────────────────────────
create or replace function private.store_setting(p_store uuid, p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((s.settings->>p_key)::integer, p_default) from public.stores s where s.id = p_store;
$$;

-- ─────────────────────────────────────────────
-- 空き時間
-- ─────────────────────────────────────────────
-- スタッフごとの、その日の勤務時間帯(タイムスタンプ範囲)。
-- 通常枠(終日休みの日を除く)+ 臨時枠 から、時間帯の休みを差し引く(multirange の差)
create or replace function private.work_ranges(p_store uuid, p_date date)
returns table (staff_id uuid, r tstzrange)
language sql
stable
security definer
set search_path = ''
as $$
  with tz as (select s.timezone as z from public.stores s where s.id = p_store),
  work as (
    select sc.staff_id, sc.start_time, sc.end_time
    from public.staff_schedules sc join public.staff st on st.id = sc.staff_id and st.active
    where sc.store_id = p_store and sc.weekday = extract(dow from p_date)::int
      and not exists (select 1 from public.schedule_exceptions e
                      where e.store_id = p_store and e.staff_id = sc.staff_id and e.date = p_date
                        and e.kind = 'off' and e.start_time is null)
    union all
    select e.staff_id, e.start_time, e.end_time
    from public.schedule_exceptions e join public.staff st on st.id = e.staff_id and st.active
    where e.store_id = p_store and e.date = p_date and e.kind = 'extra'
  ),
  w as (
    select x.staff_id,
           range_agg(tstzrange((p_date + x.start_time) at time zone tz.z, (p_date + x.end_time) at time zone tz.z, '[)')) as m
    from work x, tz group by x.staff_id
  ),
  o as (
    select e.staff_id,
           range_agg(tstzrange((p_date + e.start_time) at time zone tz.z, (p_date + e.end_time) at time zone tz.z, '[)')) as m
    from public.schedule_exceptions e, tz
    where e.store_id = p_store and e.date = p_date and e.kind = 'off' and e.start_time is not null
    group by e.staff_id
  )
  select w.staff_id, u.r
  from w left join o on o.staff_id = w.staff_id,
       lateral unnest(w.m - coalesce(o.m, '{}'::tstzmultirange)) as u(r)
  where not isempty(u.r);
$$;

-- 予約可能な開始時刻(店舗・メニュー・期間)。スタッフ指定がなければ誰か 1 人でも空いていれば可
create or replace function public.get_available_slots(p_store uuid, p_menu uuid, p_from date, p_to date, p_staff uuid default null)
returns table (start_at timestamptz, staff_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_menu      public.menus;
  v_step      interval;
  v_dur       interval;
  v_earliest  timestamptz;
  v_last_day  date;
  d           date;
begin
  select * into v_menu from public.menus m where m.id = p_menu and m.store_id = p_store and m.active;
  if v_menu.id is null then
    raise exception 'menu_invalid' using errcode = 'P0001';
  end if;
  if p_to < p_from or p_to - p_from > 31 then
    raise exception 'range_invalid' using errcode = 'P0001';
  end if;
  v_step := make_interval(mins => private.store_setting(p_store, 'slot_minutes', 30));
  v_dur := make_interval(mins => v_menu.duration_min);
  v_earliest := now() + make_interval(mins => private.store_setting(p_store, 'lead_minutes', 60));
  v_last_day := (now() at time zone (select s.timezone from public.stores s where s.id = p_store))::date
                + private.store_setting(p_store, 'max_days_ahead', 60);

  d := p_from;
  while d <= least(p_to, v_last_day) loop
    return query
      with w as (select * from private.work_ranges(p_store, d) wr where p_staff is null or wr.staff_id = p_staff),
      cand as (
        select w.staff_id, gs as s
        from w, generate_series(lower(w.r), upper(w.r) - v_dur, v_step) gs
      ),
      free as (
        select c.staff_id, c.s from cand c
        where c.s >= v_earliest
          and not exists (select 1 from public.bookings b
                          where b.staff_id = c.staff_id and b.status = 'confirmed'
                            and b.period && tstzrange(c.s, c.s + v_dur, '[)'))
      )
      select f.s, array_agg(f.staff_id order by f.staff_id) from free f group by f.s order by f.s;
    d := d + 1;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────
-- 予約作成(お客様:未ログイン / スタッフ:ログイン)
-- ─────────────────────────────────────────────
create or replace function private.match_or_create_customer(p_name text, p_phone text, p_lang text, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  integer;
begin
  perform pg_advisory_xact_lock(hashtext('questionnaire:' || p_phone));
  select count(*) into v_n from public.customers c
  where c.phone_normalized = p_phone and private.name_key(c.name) = private.name_key(p_name) and c.status = 'active';
  if v_n = 1 then
    select c.id into v_id from public.customers c
    where c.phone_normalized = p_phone and private.name_key(c.name) = private.name_key(p_name) and c.status = 'active';
    update public.customers c set email = coalesce(c.email, p_email) where c.id = v_id;
    return v_id;
  end if;
  insert into public.customers (name, phone_normalized, lang, email)
  values (p_name, p_phone, p_lang, p_email) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.create_booking(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request  uuid;
  v_prev     jsonb;
  v_store    uuid;
  v_menu     public.menus;
  v_start    timestamptz;
  v_staff    uuid;
  v_ok       uuid[];
  v_customer uuid;
  v_is_staff boolean;
  v_name     text := trim(coalesce(p->>'name', ''));
  v_phone    text := public.normalize_phone(p->>'phone');
  v_lang     text := coalesce(p->>'lang', 'ja');
  v_email    text := nullif(lower(trim(coalesce(p->>'email', ''))), '');
  v_note     text := nullif(trim(coalesce(p->>'note', '')), '');
  v_future   integer;
  v_id       uuid := gen_random_uuid();
  v_token    uuid;
  v_result   jsonb;
begin
  begin
    v_request := (p->>'request_id')::uuid;
    v_store   := (p->>'store_id')::uuid;
    v_start   := (p->>'start_at')::timestamptz;
  exception when others then
    raise exception 'input_invalid' using errcode = 'P0001';
  end;
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request);
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;
  if v_store is null or not exists (select 1 from public.stores s where s.id = v_store) then
    raise exception 'store_invalid' using errcode = 'P0001';
  end if;
  v_is_staff := private.is_staff_of(v_store);

  select * into v_menu from public.menus m where m.id = (p->>'menu_id')::uuid and m.store_id = v_store and m.active;
  if v_menu.id is null then
    raise exception 'menu_invalid' using errcode = 'P0001';
  end if;
  if v_start is null then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'text_too_long' using errcode = 'P0001';
  end if;

  -- お客様: 氏名・電話で照合 / スタッフ: 既存の患者を指定
  if v_is_staff and p ? 'customer_id' then
    select c.id into v_customer from public.customers c where c.id = (p->>'customer_id')::uuid and c.status = 'active';
    if v_customer is null then
      raise exception 'customer_not_found' using errcode = 'P0001';
    end if;
  else
    if length(v_name) = 0 or length(v_name) > 60 then
      raise exception 'name_invalid' using errcode = 'P0001';
    end if;
    if v_phone !~ '^0\d{9,10}$' then
      raise exception 'phone_invalid' using errcode = 'P0001';
    end if;
    if v_lang not in ('ja', 'es', 'pt') then
      raise exception 'lang_invalid' using errcode = 'P0001';
    end if;
    if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      raise exception 'email_invalid' using errcode = 'P0001';
    end if;
    -- 同じ電話番号の未来の予約は上限まで(いたずら対策)
    select count(*) into v_future from public.bookings b join public.customers c on c.id = b.customer_id
    where c.phone_normalized = v_phone and b.status = 'confirmed' and upper(b.period) > now();
    if v_future >= private.store_setting(v_store, 'max_future_per_phone', 3) then
      raise exception 'too_many_bookings' using errcode = 'P0001';
    end if;
    v_customer := private.match_or_create_customer(v_name, v_phone, v_lang, v_email);
  end if;

  -- その時刻が空いているか(スタッフはリードタイム・受付期間の制限なし)
  if v_is_staff then
    select array_agg(w.staff_id) into v_ok
    from private.work_ranges(v_store, (v_start at time zone (select timezone from public.stores where id = v_store))::date) w
    where tstzrange(v_start, v_start + make_interval(mins => v_menu.duration_min), '[)') <@ w.r
      and not exists (select 1 from public.bookings b where b.staff_id = w.staff_id and b.status = 'confirmed'
                        and b.period && tstzrange(v_start, v_start + make_interval(mins => v_menu.duration_min), '[)'));
  else
    select s.staff_ids into v_ok
    from public.get_available_slots(v_store, v_menu.id,
           (v_start at time zone (select timezone from public.stores where id = v_store))::date,
           (v_start at time zone (select timezone from public.stores where id = v_store))::date) s
    where s.start_at = v_start;
  end if;
  if v_ok is null or cardinality(v_ok) = 0 then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;
  v_staff := coalesce(nullif(p->>'staff_id', '')::uuid, v_ok[1]);
  if not (v_staff = any (v_ok)) then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;

  begin
    insert into public.bookings (id, store_id, staff_id, customer_id, menu_id, period, source, note, request_id)
    values (v_id, v_store, v_staff, v_customer, v_menu.id,
            tstzrange(v_start, v_start + make_interval(mins => v_menu.duration_min), '[)'),
            case when v_is_staff then 'staff' else 'web' end, v_note, v_request)
    returning cancel_token into v_token;
  exception when exclusion_violation then
    -- 同時に同じ枠を取られた
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end;

  v_result := jsonb_build_object('booking_id', v_id, 'cancel_token', v_token, 'start_at', v_start,
                                 'end_at', v_start + make_interval(mins => v_menu.duration_min));
  insert into private.idempotency (request_id, fn, result) values (v_request, 'create_booking', v_result);
  return v_result;
end;
$$;

-- お客様向け: キャンセル用トークンで予約内容を確認(個人情報は名前の頭文字だけ)
create or replace function public.get_booking_by_token(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('start_at', lower(b.period), 'end_at', upper(b.period), 'status', b.status,
                            'menu_name', m.name, 'menu_id', m.id,
                            'can_cancel', b.status = 'confirmed'
                              and lower(b.period) - make_interval(hours => private.store_setting(b.store_id, 'cancel_hours', 3)) > now())
  from public.bookings b join public.menus m on m.id = b.menu_id
  where b.cancel_token = p_token;
$$;

create or replace function public.cancel_booking(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_token uuid;
  v_id uuid;
begin
  begin
    v_token := nullif(p->>'cancel_token', '')::uuid;
    v_id := nullif(p->>'booking_id', '')::uuid;
  exception when others then
    raise exception 'input_invalid' using errcode = 'P0001';
  end;
  if v_token is not null then
    select * into v_b from public.bookings b where b.cancel_token = v_token for update;
    if v_b.id is null then
      raise exception 'booking_not_found' using errcode = 'P0001';
    end if;
    if v_b.status = 'cancelled' then
      return jsonb_build_object('cancelled', true, 'duplicate', true);
    end if;
    if v_b.status <> 'confirmed' then
      raise exception 'booking_not_cancellable' using errcode = 'P0001';
    end if;
    if lower(v_b.period) - make_interval(hours => private.store_setting(v_b.store_id, 'cancel_hours', 3)) <= now() then
      raise exception 'cancel_deadline_passed' using errcode = 'P0001';
    end if;
    update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer' where id = v_b.id;
  else
    select * into v_b from public.bookings b where b.id = v_id for update;
    if v_b.id is null or not private.is_staff_of(v_b.store_id) then
      raise exception 'booking_not_found' using errcode = 'P0001';
    end if;
    if v_b.status = 'cancelled' then
      return jsonb_build_object('cancelled', true, 'duplicate', true);
    end if;
    update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff' where id = v_b.id;
  end if;
  return jsonb_build_object('cancelled', true);
end;
$$;

-- スタッフ: 予約の状態を変える(来店済み・無断キャンセル)
create or replace function public.set_booking_status(p_booking uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
begin
  select * into v_b from public.bookings b where b.id = p_booking for update;
  if v_b.id is null or not private.is_staff_of(v_b.store_id) then
    raise exception 'booking_not_found' using errcode = 'P0001';
  end if;
  if p_status not in ('completed', 'no_show', 'confirmed') then
    raise exception 'status_invalid' using errcode = 'P0001';
  end if;
  begin
    update public.bookings set status = p_status where id = v_b.id;
  exception when exclusion_violation then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end;
end;
$$;

-- ─────────────────────────────────────────────
-- 権限
-- ─────────────────────────────────────────────
alter table public.staff_schedules enable row level security;
alter table public.schedule_exceptions enable row level security;
alter table public.bookings enable row level security;
revoke all on public.staff_schedules, public.schedule_exceptions, public.bookings from anon, authenticated;

-- 勤務枠: 同じ店舗のスタッフは閲覧、owner が編集(設定なので削除も可)
grant select, insert, update, delete on public.staff_schedules, public.schedule_exceptions to authenticated;
create policy schedules_staff_select on public.staff_schedules for select to authenticated using (private.is_staff_of(store_id));
create policy schedules_owner_write on public.staff_schedules for all to authenticated
  using (private.is_owner_of(store_id)) with check (private.is_owner_of(store_id));
create policy exceptions_staff_select on public.schedule_exceptions for select to authenticated using (private.is_staff_of(store_id));
create policy exceptions_staff_write on public.schedule_exceptions for all to authenticated
  using (private.is_staff_of(store_id)) with check (private.is_staff_of(store_id));

-- 予約: スタッフは自店舗を閲覧のみ(作成・変更は関数経由)
grant select on public.bookings to authenticated;
create policy bookings_staff_select on public.bookings for select to authenticated using (private.is_staff_of(store_id));

revoke all on function public.get_available_slots(uuid, uuid, date, date, uuid), public.create_booking(jsonb),
                       public.get_booking_by_token(uuid), public.cancel_booking(jsonb), public.set_booking_status(uuid, text) from public;
grant execute on function public.get_available_slots(uuid, uuid, date, date, uuid), public.create_booking(jsonb),
                          public.get_booking_by_token(uuid), public.cancel_booking(jsonb) to anon, authenticated;
grant execute on function public.set_booking_status(uuid, text) to authenticated;
