// 施術記録送信: 顧客・紹介者の実在チェック(#1, 2026-10-02)
const test = require('node:test');
const assert = require('node:assert');
const { loadGas, post } = require('./harness');

const TOKEN = 'a'.repeat(43);

function customerRow(id, name, status) {
  const r = new Array(23).fill('');
  r[0] = id; r[1] = name; r[10] = status || 'active';
  return r;
}

function tabs() {
  return {
    '顧客マスタ': [new Array(23).fill('h'), customerRow('P001', 'A'), customerRow('P002', 'B'), customerRow('P003', 'C', 'archived')],
    '施術台帳': [new Array(21).fill('h')],
    'クレジット台帳': [new Array(10).fill('h')],
    'アクセスログ': [new Array(7).fill('h')],
    '来店ログ': [new Array(17).fill('h')],
    '_sync': [[0]],
  };
}

function submit(g, extra) {
  return post(g, Object.assign({
    action: 'submitTreatmentRecord', deviceToken: TOKEN, requestId: 'r-' + Math.random(),
    customerId: 'P001', attended: true, courseId: 'chiro', paymentMethod: '現金', salesAmount: 4000,
  }, extra));
}

function load() {
  return loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN, LEDGER_SPREADSHEET_ID: 'x' }, tabs: tabs() });
}

test('存在しない顧客は拒否・何も書き込まない', () => {
  const g = load();
  assert.strictEqual(submit(g, { customerId: 'P999' }).error, 'customer_not_found');
  assert.strictEqual(g.__ss.tabs['施術台帳'].length, 1);
  assert.strictEqual(g.__ss.tabs['クレジット台帳'].length, 1);
});

test('archived 顧客は拒否', () => {
  assert.strictEqual(submit(load(), { customerId: 'P003' }).error, 'customer_not_found');
});

test('自分自身を紹介者にしたクレジット付与は拒否', () => {
  const g = load();
  assert.strictEqual(submit(g, { referralDiscount: true, referrerId: 'P001' }).error, 'referrer_invalid');
  assert.strictEqual(g.__ss.tabs['クレジット台帳'].length, 1);
});

test('存在しない紹介者は拒否', () => {
  assert.strictEqual(submit(load(), { referralDiscount: true, referrerId: 'P999' }).error, 'referrer_invalid');
});

test('正常な紹介付き記録は施術行 1 行と紹介 grant 1 行を書く', () => {
  const g = load();
  const res = submit(g, { referralDiscount: true, referrerId: 'P002' });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  const tr = g.__ss.tabs['施術台帳'];
  assert.strictEqual(tr.length, 2);
  assert.strictEqual(tr[1][4], 'P001');
  const cr = g.__ss.tabs['クレジット台帳'];
  assert.strictEqual(cr.length, 2);
  assert.strictEqual(cr[1][2], 'P002');
  assert.strictEqual(cr[1][4], 1000);
});
