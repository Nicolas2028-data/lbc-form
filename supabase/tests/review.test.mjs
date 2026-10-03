// 2026-10-03 のコードレビューで確定したバグの再現テスト(修正前はすべて失敗していたもの)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s;
const TODAY_OVERRIDE = `
  create or replace function private.store_today(p_store uuid) returns date
  language sql stable security definer set search_path = '' as $$
    select coalesce(nullif(current_setting('test.today', true), '')::date, (now() at time zone 'Asia/Tokyo')::date)
  $$;`;

before(async () => {
  db = await createDb();
  await db.exec(TODAY_OVERRIDE);
  s = await seed(db);
});

const setToday = (d) => db.query(`select set_config('test.today', $1, false)`, [d]);
const record = (user, p) => rpc(db, user, 'record_visit', { request_id: uuid(), allow_same_day: true, ...p });
const voidVisit = (user, p) => rpc(db, user, 'void_visit', { request_id: uuid(), reason: 'x', ...p });
const avail = async (c, d) => (await one(db, `select private.credit_available($1, $2::date) as v`, [c, d])).v;
const grant = (c, amount, expires, on) => db.query(
  `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on) values ($1, 'grant', $2, 'manual', $3, $4)`,
  [c, amount, expires, on]);
const newCustomer = async (name) => (await one(db, `insert into public.customers (name) values ($1) returning id`, [name])).id;
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.startsWith(code), `expected ${code}`);
const expire = async (d) => {
  await db.exec('set role service_role');
  try { await db.query(`select public.expire_credits($1::date)`, [d]); } finally { await db.exec('reset role'); }
};

test('【お金】期限切れのクレジットは、失効処理(cron)の前でも使えない(二重使用の防止)', async () => {
  const c = await newCustomer('ExpiredBeforeCron');
  await grant(c, 1000, '2026-10-31', '2026-10-01');
  await grant(c, 1000, '2027-06-30', '2026-10-01');
  await setToday('2026-11-05');     // G1 は期限切れ、expire_credits はまだ動いていない
  assert.equal(await avail(c, '2026-11-05'), 1000);
  await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 1000 });
  assert.equal(await avail(c, '2026-11-05'), 0);
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 1000 }), 'insufficient_credit:0');
  // 使用は有効だった付与にだけ割り当てられている
  const bad = await one(db, `select count(*)::int n from public.credit_allocations a
    join public.credit_entries u on u.id = a.use_id join public.credit_entries g on g.id = a.grant_id
    where u.customer_id = $1 and g.expires_on < u.occurred_on`, [c]);
  assert.equal(bad.n, 0);
});

test('【お金】過去の来店を取り消しても、失効済みの付与へ戻った分が有効な残高に化けない', async () => {
  const c = await newCustomer('VoidAfterExpiry');
  await grant(c, 1000, '2026-10-10', '2026-10-01');
  await grant(c, 1000, '2027-06-30', '2026-10-01');
  await setToday('2026-10-05');
  const v1 = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 400 });
  await expire('2026-10-11');                    // G1 の残り 600 が失効
  await setToday('2026-10-12');
  await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 300 });
  assert.equal(await avail(c, '2026-10-12'), 700);
  await voidVisit(s.owner, { visit_id: v1.visit_id });   // 10/05 の 400 は失効済みの G1 に戻る
  assert.equal(await avail(c, '2026-10-12'), 700);
  await expire('2026-10-13');
  assert.equal(await avail(c, '2026-10-13'), 700);
  setToday('');
});

test('【権限】予約の関数は、スタッフでないログインユーザーも呼べない', async () => {
  await as(db, s.stranger, async () => {
    await assert.rejects(db.query(`select public.create_booking('{}'::jsonb)`), /permission denied/);
  });
});

test('【権限】他店舗のスタッフは、患者カードから別店舗の当日メモ・回数券を見られない', async () => {
  await setToday('2026-10-20');
  const c = await newCustomer('CardScope');
  await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', memo: '機微なメモ',
                          purchase_product_id: s.monthly2 });
  // 他店舗のスタッフにも、その店舗に所属する前提で呼ばせる
  const card = await as(db, s.otherStaff, async () => (await one(db, `select public.get_patient_card($1) as r`, [c])).r);
  assert.deepEqual(card.today_visits, []);
  assert.deepEqual(card.passes, []);
});

test('【お金】他店舗の回数券は使えない', async () => {
  await setToday('2026-10-20');
  const c = await newCustomer('OtherStorePass');
  const r = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', purchase_product_id: s.monthly2 });
  const otherMenu = (await one(db, `insert into public.menus (store_id, code, name, price) values ($1, 'x', '{}', 3000) returning id`, [s.other])).id;
  await rejects(record(s.otherStaff, { customer_id: c, menu_id: otherMenu, use_pass_id: r.pass_id }), 'pass_invalid');
});

test('【権限】同じ request_id を別の人・別の処理で使っても、前回の結果は返らない', async () => {
  await setToday('2026-10-21');
  const c = await newCustomer('IdemScope');
  const req = uuid();
  await rpc(db, s.lucas, 'record_visit', { request_id: req, customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash' });
  await rejects(rpc(db, s.owner, 'record_visit', { request_id: req, customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash' }), 'request_id_conflict');
  await rejects(rpc(db, null, 'submit_questionnaire', { request_id: req }), 'request_id_conflict');
  // 本人の再送は今までどおり重複扱い
  const again = await rpc(db, s.lucas, 'record_visit', { request_id: req, customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash' });
  assert.equal(again.duplicate, true);
});

test('【権限】スタッフでないログインユーザーは顧客番号を発行できない', async () => {
  await rejects(as(db, s.stranger, () => db.query(`select public.next_customer_code()`)), 'not_staff');
});

test('【権限】スタッフは患者番号・ログインの紐づけ・紹介者を直接書き換えられない', async () => {
  const c = await newCustomer('ColumnGuard');
  await as(db, s.lucas, async () => {
    for (const col of ['code', 'user_id', 'line_user_id', 'referred_by', 'first_visit_date']) {
      await assert.rejects(db.query(`update public.customers set ${col} = null where id = $1`, [c]), /permission denied/, col);
    }
    // 名前・メモなどは今までどおり編集できる
    await db.query(`update public.customers set name = 'ColumnGuard2', notes = 'ok' where id = $1`, [c]);
  });
  assert.equal((await one(db, `select name from public.customers where id = $1`, [c])).name, 'ColumnGuard2');
});

test('【送信待ち】来院日は今日か前日だけ。前日分は前日の日付・前日の有効期限で記録される', async () => {
  const c = await newCustomer('VisitDate');
  await grant(c, 500, '2026-10-24', '2026-10-01');   // 10/24 まで有効
  await setToday('2026-10-25');
  // 前日(10/24)の記録として届いた → 前日時点では有効なクレジットを使える
  const r = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 500, visit_date: '2026-10-24' });
  const v = await one(db, `select visit_date::text d from public.visits where id = $1`, [r.visit_id]);
  assert.equal(v.d, '2026-10-24');
  const sale = await one(db, `select occurred_on::text d from public.sales where visit_id = $1`, [r.visit_id]);
  assert.equal(sale.d, '2026-10-24');
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', visit_date: '2026-10-23' }), 'visit_date_invalid');
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', visit_date: '2026-10-26' }), 'visit_date_invalid');
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', visit_date: 'abc' }), 'visit_date_invalid');
});
