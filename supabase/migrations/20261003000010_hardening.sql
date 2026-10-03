-- セキュリティ・性能の手直し(2026-10-03 Supabase Advisors と staging との照合で発見)
--
-- [セキュリティ]
--  1. btree_gist 拡張が public スキーマに入っていた(extension_in_public)→ extensions スキーマへ
--  2. next_customer_code() を未ログインでも呼べ、顧客番号を無駄に消費できた → anon から外す
--  3. Supabase の既定権限で、ビュー v_monthly_stats に anon / authenticated の TRUNCATE・TRIGGER・REFERENCES が
--     付いていた。TRUNCATE は RLS で止まらないため、今後のテーブルにも付かないよう既定権限ごと外す
-- [性能]
--  4. RLS で auth.uid() を行ごとに評価していた(auth_rls_initplan)→ (select auth.uid()) で 1 回に
--  5. 同じ操作に許可ポリシーが重なっていた(multiple_permissive_policies)→ 1 本にまとめる
--  6. 取消処理(void_visit)で引く外部キーに索引がなかった → 追加

-- 1. 拡張は extensions スキーマへ(排他制約は OID で参照しているので影響なし)
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter extension btree_gist set schema extensions;

-- 2. 顧客番号の採番は、スタッフの直接登録(列の既定値)と DB 関数からだけ
revoke execute on function public.next_customer_code() from public, anon;
grant execute on function public.next_customer_code() to authenticated, service_role;

-- 3. 既存のテーブル・ビューから危険な権限を外し、今後作るものにも付かないようにする
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
revoke all on public.v_monthly_stats from anon, authenticated;
grant select on public.v_monthly_stats to authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 4 + 5. ポリシーの整理
--  顧客: スタッフは全員分、本人は自分の行だけ(1 本に)
drop policy customers_staff_select on public.customers;
drop policy customers_self_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (private.is_any_staff() or user_id = (select auth.uid()));

--  同意: 閲覧は 1 本に、書き込みはスタッフのみ
drop policy consents_staff_all on public.customer_consents;
drop policy consents_self_select on public.customer_consents;
create policy consents_select on public.customer_consents for select to authenticated
  using (private.is_any_staff()
         or customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid())));
create policy consents_staff_insert on public.customer_consents for insert to authenticated
  with check (private.is_any_staff());
create policy consents_staff_update on public.customer_consents for update to authenticated
  using (private.is_any_staff()) with check (private.is_any_staff());

--  監査ログ
drop policy audit_owner_select on public.audit_log;
create policy audit_owner_select on public.audit_log for select to authenticated
  using (exists (select 1 from public.staff s
                 where s.user_id = (select auth.uid()) and s.active and s.role = 'owner'));

--  勤務枠: 閲覧はスタッフ、書き込みは owner(for all をやめて操作ごとに)
drop policy schedules_owner_write on public.staff_schedules;
create policy schedules_owner_insert on public.staff_schedules for insert to authenticated
  with check (private.is_owner_of(store_id));
create policy schedules_owner_update on public.staff_schedules for update to authenticated
  using (private.is_owner_of(store_id)) with check (private.is_owner_of(store_id));
create policy schedules_owner_delete on public.staff_schedules for delete to authenticated
  using (private.is_owner_of(store_id));

--  休み・臨時枠: 閲覧・書き込みともスタッフ(for all をやめて操作ごとに)
drop policy exceptions_staff_write on public.schedule_exceptions;
create policy exceptions_staff_insert on public.schedule_exceptions for insert to authenticated
  with check (private.is_staff_of(store_id));
create policy exceptions_staff_update on public.schedule_exceptions for update to authenticated
  using (private.is_staff_of(store_id)) with check (private.is_staff_of(store_id));
create policy exceptions_staff_delete on public.schedule_exceptions for delete to authenticated
  using (private.is_staff_of(store_id));

-- 6. 取消処理などで引く外部キーの索引
create index if not exists credit_entries_visit_id_idx on public.credit_entries (visit_id);
create index if not exists credit_entries_reverses_id_idx on public.credit_entries (reverses_id);
create index if not exists pass_uses_visit_id_idx on public.pass_uses (visit_id);
create index if not exists passes_visit_id_idx on public.passes (visit_id);
create index if not exists customers_referred_by_idx on public.customers (referred_by);
create index if not exists sales_reverses_id_idx on public.sales (reverses_id);
