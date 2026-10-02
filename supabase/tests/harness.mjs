// DB テスト用ハーネス: Docker なしで PGlite(WASM の Postgres)に Supabase 相当の
// auth スタブとロールを用意し、supabase/migrations/*.sql を順に適用する。
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Supabase が用意しているもの(ロール・auth スキーマ)の最小スタブ
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

export async function createDb() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
    } catch (e) {
      e.message = `${f}: ${e.message}`;
      throw e;
    }
  }
  return db;
}

// 指定ユーザー(null = 未ログイン)として fn を実行し、終わったら管理者に戻す
export async function as(db, userId, fn) {
  await db.exec(userId ? `set role authenticated` : `set role anon`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export async function rpc(db, userId, fn, arg) {
  return as(db, userId, async () => {
    const r = await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(arg)]);
    return r.rows[0].r;
  });
}

export async function one(db, sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

export const uuid = () => crypto.randomUUID();

// 標準的な店舗・スタッフ・メニュー・商品・顧客を作る
export async function seed(db) {
  const ids = {
    owner: uuid(), lucas: uuid(), otherStaff: uuid(), stranger: uuid(), customerUser: uuid(),
  };
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${k}@example.test`]);
  }
  const store = (await one(db, `insert into public.stores (name) values ('LBC Care') returning id`)).id;
  const other = (await one(db, `insert into public.stores (name) values ('Other Store') returning id`)).id;
  await db.query(
    `insert into public.staff (user_id, store_id, role, display_name) values
       ($1, $3, 'owner', 'Nicolas'), ($2, $3, 'staff', 'Lucas'), ($4, $5, 'staff', 'Other')`,
    [ids.owner, ids.lucas, store, ids.otherStaff, other],
  );
  const menu = {};
  for (const [code, price] of [['chiro', 4000], ['fascia', 5000], ['total', 6000]]) {
    menu[code] = (await one(db,
      `insert into public.menus (store_id, code, name, price) values ($1, $2, $3, $4) returning id`,
      [store, code, JSON.stringify({ ja: code }), price])).id;
  }
  const monthly2 = (await one(db,
    `insert into public.products (store_id, code, kind, name, price, uses, validity)
     values ($1, 'monthly2', 'ticket', '{"ja":"月2回プラン"}', 10000, 2, 'end_of_month') returning id`,
    [store])).id;
  const cust = {};
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    cust[name] = (await one(db, `insert into public.customers (name) values ($1) returning id`, [name])).id;
  }
  await db.query(`update public.customers set user_id = $1 where id = $2`, [ids.customerUser, cust.A]);
  return { ...ids, store, other, menu, monthly2, cust };
}
