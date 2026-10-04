// データが増えたときの検索・集計(2026-10-04 負荷テストで発見した問題の再現テスト)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s;
before(async () => {
  db = await createDb();
  s = await seed(db);
  // 1,200 人(Supabase の API の上限 1,000 を超える)
  await db.exec(`insert into public.customers (name, furigana, phone_normalized)
    select 'Bulk ' || g, 'バルク', '0800' || lpad(g::text, 7, '0') from generate_series(1, 1200) g`);
  await db.query(`insert into public.customers (name, furigana, phone_normalized) values ('山田 花子', 'ヤマダ ハナコ', '09012345678')`);
});

const search = (user, q, limit) => as(db, user, async () =>
  (await db.query(`select * from public.search_customers($1, $2)`, [q, limit ?? 50])).rows);

test('検索: 1,000 人を超えても、1,001 人目以降の患者を検索で見つけられる', async () => {
  const r = await search(s.lucas, 'Bulk 1199');
  assert.equal(r[0].name, 'Bulk 1199');
});

test('検索: 空なら件数制限つきで返す(全員分を画面に送らない)', async () => {
  assert.equal((await search(s.lucas, '')).length, 50);
  assert.equal((await search(s.lucas, '', 100000)).length, 200);
});

test('検索: カタカナ/ひらがな・空白・電話番号(ハイフンあり)・患者番号で見つかる', async () => {
  for (const q of ['やまだ', 'ヤマダハナコ', '山田花子', '090-1234', '5678']) {
    const r = await search(s.lucas, q);
    assert.ok(r.some((x) => x.name === '山田 花子'), q);
  }
  const code = (await one(db, `select code from public.customers where name = '山田 花子'`)).code;
  assert.equal((await search(s.lucas, code.toLowerCase()))[0].name, '山田 花子');
});

test('検索: スタッフ以外は自分以外を検索できない(RLS)', async () => {
  assert.deepEqual(await search(s.stranger, 'Bulk'), []);
  await as(db, null, async () => {
    await assert.rejects(db.query(`select * from public.search_customers('Bulk')`), /permission denied/);
  });
});

test('月別集計: 関数版は直近の月だけを返し、ビューと同じ値になる', async () => {
  const c = (await one(db, `insert into public.customers (name) values ('Stats') returning id`)).id;
  await rpc(db, s.lucas, 'record_visit', { request_id: uuid(), customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash' });
  await rpc(db, s.lucas, 'record_visit', { request_id: uuid(), customer_id: c, menu_id: s.menu.fascia, payment_method: 'unpaid', allow_same_day: true });
  const fn = await as(db, s.lucas, async () => (await db.query(`select * from public.get_monthly_stats(3)`)).rows);
  assert.equal(fn.length, 3);
  const view = await as(db, s.lucas, async () => (await db.query(`select * from public.v_monthly_stats where store_id = $1`, [s.store])).rows);
  const cur = fn[0];
  const v = view.find((x) => String(x.month) === String(cur.month));
  assert.deepEqual(
    [cur.visits, cur.new_customers, cur.sales_total, cur.unpaid_total, cur.avg_per_visit],
    [v.visits, v.new_customers, v.sales_total, v.unpaid_total, v.avg_per_visit]);
  await assert.rejects(as(db, s.stranger, () => db.query(`select * from public.get_monthly_stats()`)), /not_staff/);
});
