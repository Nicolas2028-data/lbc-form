import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s;

before(async () => {
  db = await createDb();
  s = await seed(db);
});

const record = (user, p) => rpc(db, user, 'record_visit', { request_id: uuid(), ...p });
const voidVisit = (user, p) => rpc(db, user, 'void_visit', { request_id: uuid(), ...p });
const card = (user, customer) =>
  as(db, user, async () => (await one(db, `select public.get_patient_card($1) as r`, [customer])).r);
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.startsWith(code), `expected ${code}`);

test('通常の記録: 料金はメニューから DB が決め、画面の金額は無視する', async () => {
  const r = await record(s.lucas, {
    customer_id: s.cust.C, menu_id: s.menu.chiro, payment_method: 'cash', total: 1, amount: 1,
  });
  assert.equal(r.total, 4000);
  const sale = await one(db, `select amount, method from public.sales where visit_id = $1`, [r.visit_id]);
  assert.deepEqual(sale, { amount: 4000, method: 'cash' });
});

test('冪等性: 同じ request_id の再送は 1 件しか記録されず、同じ結果を返す', async () => {
  const req = uuid();
  const p = { request_id: req, customer_id: s.cust.D, menu_id: s.menu.fascia, payment_method: 'card' };
  const a = await rpc(db, s.lucas, 'record_visit', p);
  const b = await rpc(db, s.lucas, 'record_visit', p);
  assert.equal(b.duplicate, true);
  assert.equal(b.visit_id, a.visit_id);
  const n = await one(db, `select count(*)::int n from public.visits where request_id = $1`, [req]);
  assert.equal(n.n, 1);
});

test('施術なし(no-show)は理由が必須で、売上は立たない', async () => {
  await rejects(record(s.lucas, { customer_id: s.cust.E, attended: false }), 'no_show_reason_required');
  const r = await record(s.lucas, { customer_id: s.cust.E, attended: false, no_show_reason: '体調不良' });
  assert.equal(r.total, 0);
  const n = await one(db, `select count(*)::int n from public.sales where visit_id = $1`, [r.visit_id]);
  assert.equal(n.n, 0);
});

test('支払方法なしで有料の記録はできない / 不正なメニューは拒否', async () => {
  await rejects(record(s.lucas, { customer_id: s.cust.E, menu_id: s.menu.chiro }), 'payment_method_required');
  await rejects(record(s.lucas, { customer_id: s.cust.E, menu_id: uuid(), payment_method: 'cash' }), 'menu_invalid');
});

test('紹介: 初回は ¥1,000 引き・紹介者に ¥1,000(1 年有効)、自己紹介・2 回目・クレジット併用は拒否', async () => {
  const B = s.cust.B;
  await rejects(record(s.lucas, { customer_id: B, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: B }), 'referrer_invalid');
  await rejects(record(s.lucas, { customer_id: B, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: uuid() }), 'referrer_invalid');

  const r = await record(s.lucas, { customer_id: B, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: s.cust.A });
  assert.equal(r.total, 3000);
  assert.equal(r.breakdown.referral_discount, 1000);
  const g = await one(db,
    `select amount, expires_on - occurred_on as days from public.credit_entries
     where customer_id = $1 and kind = 'grant' and visit_id = $2`, [s.cust.A, r.visit_id]);
  assert.equal(g.amount, 1000);
  assert.ok(g.days === 365 || g.days === 366);
  assert.equal((await one(db, `select referred_by from public.customers where id = $1`, [B])).referred_by, s.cust.A);

  await rejects(record(s.lucas, { customer_id: B, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: s.cust.A }), 'referral_not_first_visit');
});

test('紹介クレジットは紹介者 1 人あたり 3 件まで(割引は適用し、上限到達を返す)', async () => {
  const referrer = (await one(db, `insert into public.customers (name) values ('Referrer') returning id`)).id;
  const results = [];
  for (let i = 0; i < 4; i++) {
    const c = (await one(db, `insert into public.customers (name) values ($1) returning id`, [`New${i}`])).id;
    results.push(await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: referrer }));
  }
  assert.deepEqual(results.map((r) => r.referral_limit_reached), [false, false, false, true]);
  assert.deepEqual(results.map((r) => r.total), [3000, 3000, 3000, 3000]);
  const bal = await card(s.lucas, referrer);
  assert.equal(bal.credit_available, 3000);
});

test('クレジット使用: 残高以内なら差し引き、残高超過・金額超過・紹介との併用は拒否', async () => {
  const c = (await one(db, `insert into public.customers (name) values ('Credit') returning id`)).id;
  await db.query(
    `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on)
     values ($1, 'grant', 1500, 'manual', current_date + 100, current_date)`, [c]);
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 2000 }), 'insufficient_credit:1500');
  const r = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 500 });
  assert.equal(r.total, 3500);
  assert.equal(r.credit_available, 1000);
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: -1 }), 'credit_invalid');

  // クレジットで全額払うなら支払方法は不要
  await db.query(
    `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on)
     values ($1, 'grant', 5000, 'manual', current_date + 100, current_date)`, [c]);
  const all = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, credit_use: 4000 });
  assert.equal(all.total, 0);
  assert.equal(all.credit_available, 2000);
  // 残高は足りても、料金(4,000)を超える使用は拒否
  await db.query(
    `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on)
     values ($1, 'grant', 5000, 'manual', current_date + 100, current_date)`, [c]);
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 4500 }), 'credit_exceeds_amount');
});

test('クレジットは期限の近い順に消費され、期限切れの残りだけが失効する', async () => {
  const c = (await one(db, `insert into public.customers (name) values ('FIFO') returning id`)).id;
  await db.query(
    `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on) values
       ($1, 'grant', 1000, 'manual', current_date + 300, current_date),
       ($1, 'grant', 1000, 'manual', current_date + 10, current_date)`, [c]);
  await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 600 });

  // 期限 +10 日のロットから 600 消費 → 残り 400 が 11 日後に失効
  const before = await card(s.lucas, c);
  assert.deepEqual(before.credit_expiring, [{ expires_on: before.credit_expiring[0].expires_on, amount: 400 }]);

  await db.exec(`set role service_role`);
  const n = (await one(db, `select public.expire_credits(current_date + 11) as n`)).n;
  await db.exec(`reset role`);
  assert.ok(n >= 1);
  const exp = await one(db, `select sum(amount)::int a from public.credit_entries where customer_id = $1 and kind = 'expire'`, [c]);
  assert.equal(exp.a, -400);
  const bal = await one(db, `select sum(amount)::int a from public.credit_entries where customer_id = $1`, [c]);
  assert.equal(bal.a, 1000);
  // 2 回目の実行では何も起きない
  await db.exec(`set role service_role`);
  await one(db, `select public.expire_credits(current_date + 11)`);
  await db.exec(`reset role`);
  const exp2 = await one(db, `select count(*)::int n from public.credit_entries where customer_id = $1 and kind = 'expire'`, [c]);
  assert.equal(exp2.n, 1);
});

test('月2回プラン: 購入と同時に使用 → 2 回目は 0 円 → 3 回目は使い切りで拒否。期限は当月末', async () => {
  const c = (await one(db, `insert into public.customers (name) values ('Monthly') returning id`)).id;
  const first = await record(s.lucas, {
    customer_id: c, menu_id: s.menu.total, payment_method: 'paypay',
    purchase_product_id: s.monthly2, use_purchased_pass: true,
  });
  assert.equal(first.total, 10000);
  const pass = await one(db,
    `select valid_until = (date_trunc('month', current_date) + interval '1 month - 1 day')::date as eom
     from public.passes where id = $1`, [first.pass_id]);
  assert.equal(pass.eom, true);

  const second = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, use_pass_id: first.pass_id });
  assert.equal(second.total, 0);
  await rejects(record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, use_pass_id: first.pass_id }), 'pass_used_up');

  // 申込だけ(今回はメニュー料金+プラン料金)
  const addon = await record(s.lucas, {
    customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', purchase_product_id: s.monthly2,
  });
  assert.equal(addon.total, 14000);
  const remaining = (await card(s.lucas, c)).passes.find((p) => p.id === addon.pass_id).remaining;
  assert.equal(remaining, 2);

  // 他人の回数券は使えない
  await rejects(record(s.lucas, { customer_id: s.cust.C, menu_id: s.menu.chiro, use_pass_id: addon.pass_id }), 'pass_invalid');
});

test('取消(赤伝): 売上・クレジット使用・紹介付与・回数券をすべて打ち消す。二重取消は不可', async () => {
  const referrer = (await one(db, `insert into public.customers (name) values ('VoidRef') returning id`)).id;
  const c = (await one(db, `insert into public.customers (name) values ('VoidMe') returning id`)).id;
  const r = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: referrer });

  await rejects(voidVisit(s.lucas, { visit_id: r.visit_id }), 'void_reason_required');
  const v = await voidVisit(s.lucas, { visit_id: r.visit_id, reason: 'コース間違い' });
  assert.equal(v.voided, true);

  const sales = await one(db, `select sum(amount)::int a from public.sales where visit_id = $1`, [r.visit_id]);
  assert.equal(sales.a, 0);
  assert.equal((await card(s.lucas, referrer)).credit_available, 0);
  await rejects(voidVisit(s.lucas, { visit_id: r.visit_id, reason: 'again' }), 'already_voided');

  // 取消後は「初回」に戻るので、もう一度紹介付きで記録できる
  const again = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', referrer_id: referrer });
  assert.equal(again.total, 3000);
});

test('取消: クレジット使用・回数券使用の取消で残高・残り回数が戻る', async () => {
  const c = (await one(db, `insert into public.customers (name) values ('Restore') returning id`)).id;
  await db.query(
    `insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on)
     values ($1, 'grant', 1000, 'manual', current_date + 100, current_date)`, [c]);
  const buy = await record(s.lucas, {
    customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', purchase_product_id: s.monthly2,
  });
  const use = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, use_pass_id: buy.pass_id });
  const cr = await record(s.lucas, { customer_id: c, menu_id: s.menu.chiro, payment_method: 'cash', credit_use: 1000 });

  // 他の来店で使われた回数券を買った来店は取消できない
  await rejects(voidVisit(s.lucas, { visit_id: buy.visit_id, reason: 'x' }), 'pass_in_use');

  await voidVisit(s.lucas, { visit_id: use.visit_id, reason: 'x' });
  await voidVisit(s.lucas, { visit_id: cr.visit_id, reason: 'x' });
  const after = await card(s.lucas, c);
  assert.equal(after.credit_available, 1000);
  assert.equal(after.passes.find((p) => p.id === buy.pass_id).remaining, 2);

  // 使用を取り消したので、購入した来店も取消できる
  await voidVisit(s.lucas, { visit_id: buy.visit_id, reason: 'x' });
  const ps = await one(db, `select status from public.passes where id = $1`, [buy.pass_id]);
  assert.equal(ps.status, 'voided');
});

test('取消: スタッフは当日分のみ、過去日は owner のみ', async () => {
  const r = await record(s.lucas, { customer_id: s.cust.F, menu_id: s.menu.chiro, payment_method: 'cash' });
  await db.query(`update public.visits set visit_date = visit_date - 1 where id = $1`, [r.visit_id]);
  await rejects(voidVisit(s.lucas, { visit_id: r.visit_id, reason: 'x' }), 'void_past_requires_owner');
  const v = await voidVisit(s.owner, { visit_id: r.visit_id, reason: 'x' });
  assert.equal(v.voided, true);
});

test('権限: スタッフ以外は記録できない / 他店舗のスタッフは記録も閲覧もできない', async () => {
  await rejects(record(s.stranger, { customer_id: s.cust.C, menu_id: s.menu.chiro, payment_method: 'cash' }), 'not_staff');
  await rejects(record(s.otherStaff, { customer_id: s.cust.C, menu_id: s.menu.chiro, payment_method: 'cash' }), 'menu_invalid');
  const seen = await as(db, s.otherStaff, async () =>
    (await one(db, `select count(*)::int n from public.visits where store_id = $1`, [s.store])).n);
  assert.equal(seen, 0);
  const own = await as(db, s.lucas, async () =>
    (await one(db, `select count(*)::int n from public.visits where store_id = $1`, [s.store])).n);
  assert.ok(own > 0);
});

test('権限: 未ログインは顧客・来店・売上を読めず、関数も呼べない', async () => {
  await as(db, null, async () => {
    await assert.rejects(db.query(`select * from public.customers`), /permission denied/);
    await assert.rejects(db.query(`select * from public.sales`), /permission denied/);
    await assert.rejects(db.query(`select public.record_visit('{}'::jsonb)`), /permission denied/);
  });
  // メニューは予約画面のために読める
  const menus = await as(db, null, async () => (await one(db, `select count(*)::int n from public.menus`)).n);
  assert.equal(menus, 3);
});

test('権限: 顧客本人(マイページ)は自分の顧客情報だけ読め、来店・売上は直接読めない', async () => {
  const rows = await as(db, s.customerUser, async () => (await db.query(`select id from public.customers`)).rows);
  assert.deepEqual(rows.map((r) => r.id), [s.cust.A]);
  const visits = await as(db, s.customerUser, async () => (await one(db, `select count(*)::int n from public.visits`)).n);
  assert.equal(visits, 0);
});

test('権限: 売上・来店はスタッフでも直接書き込めない(関数経由のみ)', async () => {
  await as(db, s.lucas, async () => {
    await assert.rejects(
      db.query(`insert into public.sales (store_id, customer_id, kind, amount, method, occurred_on)
                values ($1, $2, 'sale', 1, 'cash', current_date)`, [s.store, s.cust.C]),
      /permission denied/);
    await assert.rejects(db.query(`update public.visits set memo = 'x'`), /permission denied/);
  });
});

test('月別集計ビュー: 来院数・新規・売上(未払い除く)・未収', async () => {
  const st = await one(db, `insert into public.stores (name) values ('Stats') returning id`);
  const owner = uuid();
  await db.query(`insert into auth.users (id) values ($1)`, [owner]);
  await db.query(`insert into public.staff (user_id, store_id, role, display_name) values ($1, $2, 'owner', 'o')`, [owner, st.id]);
  const m = await one(db, `insert into public.menus (store_id, code, name, price) values ($1, 'x', '{}', 5000) returning id`, [st.id]);
  const c1 = (await one(db, `insert into public.customers (name) values ('S1') returning id`)).id;
  const c2 = (await one(db, `insert into public.customers (name) values ('S2') returning id`)).id;
  await record(owner, { customer_id: c1, menu_id: m.id, payment_method: 'cash' });
  await record(owner, { customer_id: c2, menu_id: m.id, payment_method: 'unpaid' });
  await record(owner, { customer_id: c1, menu_id: m.id, payment_method: 'card' });
  const row = await as(db, owner, async () => one(db, `select * from public.v_monthly_stats where store_id = $1`, [st.id]));
  assert.equal(row.visits, 3);
  assert.equal(row.new_customers, 2);
  assert.equal(row.sales_total, 10000);
  assert.equal(row.unpaid_total, 5000);
  assert.equal(row.avg_per_visit, 3333);
});

test('電話番号の正規化は現行 GAS と同じ', async () => {
  const cases = [
    ['090-1234-5678', '09012345678'], ['+81 90 1234 5678', '09012345678'],
    ['０９０１２３４５６７８', '09012345678'], ['9012345678', '09012345678'], ['', ''], [null, ''],
  ];
  for (const [input, want] of cases) {
    const r = await one(db, `select public.normalize_phone($1) as v`, [input]);
    assert.equal(r.v, want, `normalize_phone(${input})`);
  }
});
