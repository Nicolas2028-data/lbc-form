// スキーマの自動検査(Supabase Advisors で指摘される類の問題を、マイグレーションの段階で止める)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db;
before(async () => { db = await createDb(); });
const rows = async (sql) => (await db.query(sql)).rows;

// 未ログイン(anon)が実行してよい関数の一覧。増やすときはここで意図を明示する
const ANON_ALLOWED = new Set([
  'normalize_phone',        // 電話番号の正規化(副作用なし)
  'public_store',           // 店舗名と ID のみ
  'submit_questionnaire',   // 問診票(入力を厳密に検証)
]);

test('public のテーブルはすべて RLS が有効', async () => {
  const r = await rows(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`);
  assert.deepEqual(r, []);
});

test('anon / authenticated に TRUNCATE・TRIGGER・REFERENCES が付いていない(TRUNCATE は RLS で止まらない)', async () => {
  const r = await rows(`select grantee, table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
      and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')`);
  assert.deepEqual(r, []);
});

test('今後作るテーブルにも既定で権限が付かない', async () => {
  await db.exec(`create table public._lint_probe (id int)`);
  try {
    const r = await rows(`select grantee, privilege_type from information_schema.role_table_grants
      where table_name = '_lint_probe' and grantee in ('anon', 'authenticated')`);
    assert.deepEqual(r, []);
  } finally {
    await db.exec(`drop table public._lint_probe`);
  }
});

test('anon が実行できる public の関数は許可リストのものだけ', async () => {
  const r = await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') and p.prokind = 'f'`);
  const unexpected = r.map((x) => x.proname).filter((n) => !ANON_ALLOWED.has(n));
  assert.deepEqual(unexpected, []);
});

test('security definer の関数はすべて search_path を固定している(関数の乗っ取り対策)', async () => {
  const r = await rows(`select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(r, []);
});

test('拡張機能は public スキーマに置かない', async () => {
  const r = await rows(`select e.extname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where n.nspname = 'public'`);
  assert.deepEqual(r, []);
});

test('RLS ポリシーで auth.uid() を行ごとに評価しない((select auth.uid()) を使う)', async () => {
  const r = await rows(`select tablename, policyname from pg_policies where schemaname = 'public'
    and (coalesce(qual, '') ~ 'auth\\.uid\\(\\)' or coalesce(with_check, '') ~ 'auth\\.uid\\(\\)')
    and not (coalesce(qual, '') || coalesce(with_check, '')) ~ 'SELECT auth\\.uid\\(\\)'`);
  assert.deepEqual(r, []);
});

test('同じテーブル・操作・ロールに許可ポリシーが重なっていない', async () => {
  const r = await rows(`select tablename, cmd, r as role, count(*)::int n
    from pg_policies, unnest(roles) r,
         unnest(case when cmd = 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] else array[cmd] end) c(cmd2)
    where schemaname = 'public' and permissive = 'PERMISSIVE'
    group by tablename, cmd, r, c.cmd2 having count(*) > 1`);
  // menus / products の閲覧は anon と authenticated の両方に 1 本のポリシーで出している(重なりではない)
  assert.deepEqual(r, []);
});
