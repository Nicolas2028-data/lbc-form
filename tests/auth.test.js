// スタッフ系 API の端末トークン認証(#1, 2026-10-02)
const test = require('node:test');
const assert = require('node:assert');
const { loadGas, post } = require('./harness');

const TOKEN = 'a'.repeat(43);
const STAFF_ACTIONS = ['getPatientList', 'getPatientDetails', 'submitTreatmentRecord', 'submitVoidRecord', 'getDashboardData'];

test('トークン未送信のスタッフ系 action は拒否され、シートに触れない', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN } });
  for (const action of STAFF_ACTIONS) {
    assert.deepStrictEqual(post(g, { action }), { success: false, error: 'unauthorized_device' }, action);
  }
});

test('誤ったトークンは拒否される', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN } });
  const res = post(g, { action: 'getPatientList', deviceToken: 'b'.repeat(43) });
  assert.strictEqual(res.error, 'unauthorized_device');
});

test('STAFF_ACCESS_TOKEN 未設定なら全拒否(fail-closed)', () => {
  const g = loadGas({ props: {} });
  assert.strictEqual(post(g, { action: 'getPatientList', deviceToken: '' }).error, 'unauthorized_device');
  assert.strictEqual(post(g, { action: 'getPatientList', deviceToken: 'x' }).error, 'unauthorized_device');
});

test('32 文字未満のトークン設定値は無効扱い', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: 'short' } });
  assert.strictEqual(post(g, { action: 'getPatientList', deviceToken: 'short' }).error, 'unauthorized_device');
});

test('正しいトークンなら認証を通過して handler に到達する(ローテーション用の 2 個目も可)', () => {
  const second = 'c'.repeat(40);
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN + ', ' + second, LEDGER_SPREADSHEET_ID: 'x' } });
  for (const tok of [TOKEN, second]) {
    const res = post(g, { action: 'getPatientList', deviceToken: tok });
    // 認証を通ると台帳を開こうとする → モック未設定の例外 = 通過の証拠
    assert.notStrictEqual(res.error, 'unauthorized_device');
    assert.match(res.error, /SpreadsheetApp\.openById not mocked/);
  }
});

test('患者向け action はトークン不要のまま', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN } });
  const res = post(g, { action: 'lookupPatient', phone: '' });
  assert.notStrictEqual(res.error, 'unauthorized_device');
});

test('doGet から患者一覧・詳細・ダッシュボードは取れない', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN } });
  for (const action of ['getPatientList', 'getPatientDetails', 'getDashboardData']) {
    const res = JSON.parse(g.doGet({ parameter: { action } }).text);
    assert.deepStrictEqual(res, { success: false, error: 'Bad request' }, action);
  }
});

test('記録リンク: 氏名・電話を含まず、トークンはフラグメントで渡す', () => {
  const g = loadGas({ props: { STAFF_ACCESS_TOKEN: TOKEN } });
  const cfg = g.getConfig();
  const url = g.buildTreatmentRecordUrl(cfg, 'P007', '山田 太郎', '090-1234-5678');
  assert.strictEqual(url, 'https://nicolas2028-data.github.io/lbc-form/treatment-record.html?customer_id=P007#k=' + TOKEN);
});

test('記録リンク: トークン未設定ならフラグメントなし', () => {
  const g = loadGas({ props: {} });
  const url = g.buildTreatmentRecordUrl(g.getConfig(), 'P007', 'x', 'y');
  assert.strictEqual(url, 'https://nicolas2028-data.github.io/lbc-form/treatment-record.html?customer_id=P007');
});
