-- 問診票(初回のお客様が iPad / スマホで記入)
-- 設計: design.md 2.5 / 3 章 submit_questionnaire、現行 GAS handleSubmitAll / SPEC.md 4.3 の照合ルールを継続
--
--  - ログインしていないお客様が送信する → 関数は anon からも呼べるが、入力を厳密に検証し、返すのは受付結果のみ
--  - 照合: 正規化電話番号 + 氏名(空白・大文字小文字を無視)。一致すれば既存の患者に紐づけ、
--          電話番号だけ一致(家族で共用)なら別人として新規登録(現行 @121 の誤マージ修正を継続)
--  - 同じ電話番号からの送信は 1 日 5 件まで(いたずら・連打対策)
--  - 画像(人体図・署名)は Storage の非公開バケットに q/<request_id>/ で保存し、パスだけを記録

create table public.questionnaires (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id),
  customer_id   uuid not null references public.customers(id),
  submitted_at  timestamptz not null default now(),
  lang          text not null check (lang in ('ja', 'es', 'pt')),
  answers       jsonb not null,
  pain_areas    text[] not null default '{}',
  image_paths   jsonb not null default '{}'::jsonb,   -- {"body": "...", "signature": "..."}
  phone_normalized text not null,
  request_id    uuid not null unique,
  created_at    timestamptz not null default now()
);
create index on public.questionnaires (customer_id, submitted_at desc);
create index on public.questionnaires (phone_normalized, submitted_at);

alter table public.questionnaires enable row level security;
revoke all on public.questionnaires from anon, authenticated;
grant select on public.questionnaires to authenticated;
create policy questionnaires_staff_select on public.questionnaires for select to authenticated
  using (private.is_staff_of(store_id));

-- 氏名の照合キー(空白をすべて除き小文字化)
create or replace function private.name_key(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(coalesce(s, ''), '[\s　]+', '', 'g'));
$$;

-- 配列の値がすべて許可リストに含まれるか
create or replace function private.all_in(arr jsonb, allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(arr) = 'array'
     and not exists (select 1 from jsonb_array_elements_text(arr) x where not (x = any (allowed)));
$$;

create or replace function public.submit_questionnaire(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request   uuid;
  v_prev      jsonb;
  v_store     uuid;
  v_name      text := trim(coalesce(p->>'name', ''));
  v_furigana  text := nullif(trim(coalesce(p->>'furigana', '')), '');
  v_phone     text := public.normalize_phone(p->>'phone');
  v_email     text := nullif(lower(trim(coalesce(p->>'email', ''))), '');
  v_birth     date;
  v_lang      text := coalesce(p->>'lang', 'ja');
  v_how       text := nullif(p->>'how_found', '');
  a           jsonb := coalesce(p->'answers', '{}'::jsonb);
  v_images    jsonb := coalesce(p->'image_paths', '{}'::jsonb);
  v_pain      integer;
  v_customer  public.customers;
  v_matches   integer;
  v_recent    integer;
  k           text;
begin
  begin
    v_request := (p->>'request_id')::uuid;
  exception when others then
    raise exception 'request_id_required' using errcode = 'P0001';
  end;
  if v_request is null then
    raise exception 'request_id_required' using errcode = 'P0001';
  end if;
  v_prev := private.idem_get(v_request);
  if v_prev is not null then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  -- 店舗
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    v_store := null;
  end;
  if v_store is null or not exists (select 1 from public.stores s where s.id = v_store) then
    raise exception 'store_invalid' using errcode = 'P0001';
  end if;

  -- 基本情報
  if length(v_name) = 0 or length(v_name) > 60 then
    raise exception 'name_invalid' using errcode = 'P0001';
  end if;
  if v_furigana is not null and length(v_furigana) > 60 then
    raise exception 'furigana_invalid' using errcode = 'P0001';
  end if;
  if v_phone !~ '^0\d{9,10}$' then
    raise exception 'phone_invalid' using errcode = 'P0001';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email_invalid' using errcode = 'P0001';
  end if;
  begin
    v_birth := (p->>'birth_date')::date;
  exception when others then
    raise exception 'birth_date_invalid' using errcode = 'P0001';
  end;
  if v_birth is null or v_birth < date '1900-01-01' or v_birth > current_date then
    raise exception 'birth_date_invalid' using errcode = 'P0001';
  end if;
  if v_lang not in ('ja', 'es', 'pt') then
    raise exception 'lang_invalid' using errcode = 'P0001';
  end if;
  if v_how is null or v_how not in ('instagram', 'google', 'google_maps', 'referral', 'other') then
    raise exception 'how_found_invalid' using errcode = 'P0001';
  end if;

  -- 問診の回答
  if not private.all_in(a->'main_symptom', array['shoulder_stiff', 'lower_back', 'neck_stiff', 'headache', 'posture', 'fatigue', 'swelling', 'other'])
     or jsonb_array_length(a->'main_symptom') = 0 then
    raise exception 'main_symptom_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'symptom_duration', '') not in ('within_week', 'within_month', 'over_month', 'over_half_year', 'other') then
    raise exception 'symptom_duration_invalid' using errcode = 'P0001';
  end if;
  begin
    v_pain := (a->>'pain_level')::integer;
  exception when others then
    raise exception 'pain_level_invalid' using errcode = 'P0001';
  end;
  if v_pain is null or v_pain not between 0 and 10 then
    raise exception 'pain_level_invalid' using errcode = 'P0001';
  end if;
  if not private.all_in(a->'safety', array['pregnant', 'hospital', 'osteoporosis', 'blood_thinner', 'numbness', 'recent_injury', 'none'])
     or jsonb_array_length(a->'safety') = 0
     or (a->'safety' ? 'none' and jsonb_array_length(a->'safety') > 1) then
    raise exception 'safety_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'treatment_goal', '') not in ('relax', 'pain_relief', 'posture_goal', 'maintenance') then
    raise exception 'treatment_goal_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'treatment_strength', '') not in ('light', 'normal', 'strong') then
    raise exception 'treatment_strength_invalid' using errcode = 'P0001';
  end if;
  if not private.all_in(a->'disliked', array['strong_pressure', 'joint_adjustment', 'none'])
     or jsonb_array_length(a->'disliked') = 0
     or (a->'disliked' ? 'none' and jsonb_array_length(a->'disliked') > 1) then
    raise exception 'disliked_invalid' using errcode = 'P0001';
  end if;
  if coalesce(a->>'photo_consent', '') not in ('yes', 'no') then
    raise exception 'photo_consent_invalid' using errcode = 'P0001';
  end if;
  if a->>'photo_consent' = 'yes' and coalesce(a->>'face_preference', '') not in ('face_ok', 'no_face') then
    raise exception 'face_preference_invalid' using errcode = 'P0001';
  end if;
  if coalesce((a->>'consent_agreed')::boolean, false) is not true then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  -- 自由記述は長さを制限(いたずら・巨大データ対策)
  foreach k in array array['main_symptom_other', 'symptom_duration_other', 'safety_note', 'referrer_name', 'how_found_other'] loop
    if length(coalesce(a->>k, '')) > 500 then
      raise exception 'text_too_long' using errcode = 'P0001';
    end if;
  end loop;
  if length(a::text) > 20000 then
    raise exception 'answers_too_large' using errcode = 'P0001';
  end if;

  -- 画像: q/<request_id>/(body|signature).(png|jpg|webp) のみ。署名は必須
  if jsonb_typeof(v_images) <> 'object'
     or exists (select 1 from jsonb_object_keys(v_images) x where x not in ('body', 'signature'))
     or exists (select 1 from jsonb_each_text(v_images) e
                where e.value !~ ('^q/' || v_request::text || '/(body|signature)\.(png|jpg|webp)$')) then
    raise exception 'image_path_invalid' using errcode = 'P0001';
  end if;
  if not v_images ? 'signature' then
    raise exception 'signature_required' using errcode = 'P0001';
  end if;

  -- 連打・いたずら対策
  select count(*) into v_recent from public.questionnaires q
  where q.phone_normalized = v_phone and q.submitted_at > now() - interval '1 day';
  if v_recent >= 5 then
    raise exception 'too_many_submissions' using errcode = 'P0001';
  end if;

  -- 照合(電話番号 + 氏名)。同じ電話番号の同時送信は直列化
  perform pg_advisory_xact_lock(hashtext('questionnaire:' || v_phone));
  select count(*) into v_matches from public.customers c
  where c.phone_normalized = v_phone and private.name_key(c.name) = private.name_key(v_name) and c.status = 'active';

  if v_matches = 1 then
    select * into v_customer from public.customers c
    where c.phone_normalized = v_phone and private.name_key(c.name) = private.name_key(v_name) and c.status = 'active';
    update public.customers c set
      furigana   = coalesce(v_furigana, c.furigana),
      lang       = v_lang,
      birth_date = coalesce(c.birth_date, v_birth),
      email      = coalesce(c.email, v_email),
      how_found  = case when cardinality(c.how_found) = 0 then array[v_how] else c.how_found end
    where c.id = v_customer.id;
  else
    -- 0 件: 新規 / 2 件以上(同姓同名が同じ番号に複数=想定外): 安全側で新規にしてスタッフが統合判断
    insert into public.customers (name, furigana, phone_normalized, email, birth_date, lang, how_found)
    values (v_name, v_furigana, v_phone, v_email, v_birth, v_lang, array[v_how])
    returning * into v_customer;
  end if;

  insert into public.questionnaires (store_id, customer_id, lang, answers, pain_areas, image_paths, phone_normalized, request_id)
  values (v_store, v_customer.id, v_lang, a,
          coalesce((select array_agg(x) from jsonb_array_elements_text(a->'main_symptom') x), '{}'),
          v_images, v_phone, v_request);

  insert into public.customer_consents (customer_id, kind) values (v_customer.id, 'privacy');

  -- お客様に返すのは受付結果のみ(個人情報・患者番号は返さない)
  insert into private.idempotency (request_id, fn, result)
  values (v_request, 'submit_questionnaire', jsonb_build_object('accepted', true));
  return jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.submit_questionnaire(jsonb) from public;
grant execute on function public.submit_questionnaire(jsonb) to anon, authenticated;

-- 店舗の公開情報(問診・予約画面で店舗 ID を知るため)。名前と ID だけを返す
create or replace function public.public_store(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'name', s.name) from public.stores s where s.id = p_id;
$$;
grant execute on function public.public_store(uuid) to anon, authenticated;

-- Storage(Supabase 環境のみ。テスト用の PGlite には storage スキーマが無いので飛ばす)
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('questionnaire', 'questionnaire', false, 2 * 1024 * 1024, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;

    -- お客様: q/<uuid>/(body|signature).* へのアップロードのみ(読み取り・上書き・削除は不可)
    execute $p$
      create policy questionnaire_upload on storage.objects for insert to anon, authenticated
      with check (
        bucket_id = 'questionnaire'
        and name ~ '^q/[0-9a-f-]{36}/(body|signature)\.(png|jpg|webp)$'
      )
    $p$;
    -- スタッフ: 閲覧のみ
    execute $p$
      create policy questionnaire_staff_read on storage.objects for select to authenticated
      using (bucket_id = 'questionnaire' and private.is_any_staff())
    $p$;
  end if;
end;
$$;
