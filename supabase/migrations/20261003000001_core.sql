-- LBC Care 新基盤: 組織・人・メニュー・商品
-- 設計: .steering/20261003-platform-rebuild/design.md 2.1 / 2.2 / 4 章
--
-- 方針
--  - 業務テーブルの書き込みは原則 DB 関数(security definer)経由。直接書き込みは
--    顧客・メニュー等の「マスタ」に限り RLS で許可する
--  - private スキーマは API に公開しない(Supabase の公開スキーマは public のみ)

create extension if not exists btree_gist;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ─────────────────────────────────────────────
-- 共通: updated_at 自動更新
-- ─────────────────────────────────────────────
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────
-- 店舗・スタッフ
-- ─────────────────────────────────────────────
create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'Asia/Tokyo',
  address     text,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.staff (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete restrict,
  store_id      uuid not null references public.stores(id) on delete restrict,
  role          text not null check (role in ('owner', 'staff')),
  display_name  text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, store_id)
);
create index on public.staff (store_id);

-- 権限判定ヘルパー(RLS から呼ぶため security definer で staff の RLS を回避)
create or replace function private.my_store_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.store_id from public.staff s
  where s.user_id = auth.uid() and s.active;
$$;

create or replace function private.is_staff_of(p_store uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.store_id = p_store and s.active
  );
$$;

create or replace function private.is_owner_of(p_store uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.store_id = p_store and s.active and s.role = 'owner'
  );
$$;

create or replace function private.is_any_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid() and s.active);
$$;

-- ─────────────────────────────────────────────
-- 顧客(店舗をまたいで共通)
-- ─────────────────────────────────────────────
create sequence public.customer_code_seq;

-- 電話番号の正規化(現行 GAS normalizePhone と同じ規則)
create or replace function public.normalize_phone(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when s is null or s = '' then ''
    when s ~ '^81' then '0' || substr(s, 3)
    when s ~ '^\d{9,10}$' and left(s, 1) <> '0' then '0' || s
    else s
  end
  from (
    select regexp_replace(translate(coalesce(raw, ''), '０１２３４５６７８９', '0123456789'),
                          '[\s\-\(\)\.\+]', '', 'g') as s
  ) t;
$$;

create table public.customers (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique
                    default ('P' || lpad(nextval('public.customer_code_seq')::text, 3, '0')),
  name              text not null check (length(trim(name)) > 0),
  furigana          text,
  phone_normalized  text,
  email             text,
  birth_date        date,
  lang              text not null default 'ja' check (lang in ('ja', 'es', 'pt')),
  how_found         text[] not null default '{}',
  address           text,
  notes             text,
  status            text not null default 'active' check (status in ('active', 'archived')),
  referred_by       uuid references public.customers(id),
  first_visit_date  date,
  user_id           uuid unique references auth.users(id),   -- マイページ(LINE ログイン)用
  line_user_id      text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (referred_by is null or referred_by <> id)
);
create index on public.customers (phone_normalized);
create index on public.customers (status);

create trigger customers_touch before update on public.customers
  for each row execute function private.touch_updated_at();

create table public.customer_consents (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id),
  kind         text not null check (kind in ('privacy', 'line', 'email')),
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index on public.customer_consents (customer_id);

-- ─────────────────────────────────────────────
-- メニュー(施術コース)・商品(回数券・サブスク)
-- ─────────────────────────────────────────────
create table public.menus (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id),
  code          text not null,                 -- 'chiro' 等(移行・画面の安定キー)
  name          jsonb not null,                -- {"ja": "...", "es": "...", "pt": "..."}
  duration_min  integer not null default 60 check (duration_min > 0),
  price         integer not null check (price >= 0),
  active        boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (store_id, code)
);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores(id),
  code             text not null,
  kind             text not null check (kind in ('ticket', 'subscription')),
  name             jsonb not null,
  price            integer not null check (price >= 0),
  uses             integer not null check (uses > 0),
  validity         text not null check (validity in ('days', 'end_of_month')),
  valid_days       integer check (valid_days is null or valid_days > 0),
  menu_ids         uuid[],                      -- null = すべてのメニューで使える
  stripe_price_id  text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (store_id, code),
  check (validity <> 'days' or valid_days is not null)
);

create trigger menus_touch before update on public.menus
  for each row execute function private.touch_updated_at();
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();
create trigger stores_touch before update on public.stores
  for each row execute function private.touch_updated_at();
create trigger staff_touch before update on public.staff
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────
-- 監査ログ・冪等性
-- ─────────────────────────────────────────────
create table public.audit_log (
  id          bigint generated always as identity primary key,
  actor       uuid,
  action      text not null,
  table_name  text,
  row_id      uuid,
  diff        jsonb,
  at          timestamptz not null default now()
);
create index on public.audit_log (table_name, row_id);

create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor, action, table_name, row_id, diff)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(new.id, old.id),
    case tg_op
      when 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      when 'INSERT' then jsonb_build_object('new', to_jsonb(new))
      else jsonb_build_object('old', to_jsonb(old))
    end
  );
  return coalesce(new, old);
end;
$$;

create trigger customers_audit after insert or update on public.customers
  for each row execute function private.audit_row();

-- 書き込み系 DB 関数の冪等性(同じ request_id の再送には前回の結果を返す)
create table private.idempotency (
  request_id  uuid primary key,
  fn          text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 権限(RLS)
-- ─────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter table public.stores            enable row level security;
alter table public.staff             enable row level security;
alter table public.customers         enable row level security;
alter table public.customer_consents enable row level security;
alter table public.menus             enable row level security;
alter table public.products          enable row level security;
alter table public.audit_log         enable row level security;

-- 店舗: 所属スタッフが読める / owner が更新
grant select, update on public.stores to authenticated;
create policy stores_select on public.stores for select to authenticated
  using (id in (select private.my_store_ids()));
create policy stores_update on public.stores for update to authenticated
  using (private.is_owner_of(id)) with check (private.is_owner_of(id));

-- スタッフ: 同じ店舗のスタッフ一覧が読める / owner が追加・更新
grant select, insert, update on public.staff to authenticated;
create policy staff_select on public.staff for select to authenticated
  using (store_id in (select private.my_store_ids()));
create policy staff_insert on public.staff for insert to authenticated
  with check (private.is_owner_of(store_id));
create policy staff_update on public.staff for update to authenticated
  using (private.is_owner_of(store_id)) with check (private.is_owner_of(store_id));

-- 顧客: スタッフは全顧客を読み書き(店舗をまたいで共通のため)。
--       顧客本人(マイページ)は自分の行だけ読める。物理削除は誰もできない
grant select, insert, update on public.customers to authenticated;
grant usage on sequence public.customer_code_seq to authenticated;
create policy customers_staff_select on public.customers for select to authenticated
  using (private.is_any_staff());
create policy customers_self_select on public.customers for select to authenticated
  using (user_id = auth.uid());
create policy customers_staff_insert on public.customers for insert to authenticated
  with check (private.is_any_staff());
create policy customers_staff_update on public.customers for update to authenticated
  using (private.is_any_staff()) with check (private.is_any_staff());

grant select, insert, update on public.customer_consents to authenticated;
create policy consents_staff_all on public.customer_consents for all to authenticated
  using (private.is_any_staff()) with check (private.is_any_staff());
create policy consents_self_select on public.customer_consents for select to authenticated
  using (customer_id in (select c.id from public.customers c where c.user_id = auth.uid()));

-- メニュー・商品: 有効なものは誰でも読める(予約画面で使う)/ owner が管理
grant select on public.menus, public.products to anon;
grant select, insert, update on public.menus, public.products to authenticated;
create policy menus_public_select on public.menus for select to anon, authenticated
  using (active or private.is_staff_of(store_id));
create policy menus_owner_insert on public.menus for insert to authenticated
  with check (private.is_owner_of(store_id));
create policy menus_owner_update on public.menus for update to authenticated
  using (private.is_owner_of(store_id)) with check (private.is_owner_of(store_id));
create policy products_public_select on public.products for select to anon, authenticated
  using (active or private.is_staff_of(store_id));
create policy products_owner_insert on public.products for insert to authenticated
  with check (private.is_owner_of(store_id));
create policy products_owner_update on public.products for update to authenticated
  using (private.is_owner_of(store_id)) with check (private.is_owner_of(store_id));

-- 監査ログ: owner のみ読める(店舗に紐づかないため、いずれかの店舗の owner)
grant select on public.audit_log to authenticated;
create policy audit_owner_select on public.audit_log for select to authenticated
  using (exists (select 1 from public.staff s
                 where s.user_id = auth.uid() and s.active and s.role = 'owner'));
