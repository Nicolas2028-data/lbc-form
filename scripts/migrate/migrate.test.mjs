// 移行ツールの通しテスト: 現行シートで起こりうるケースを詰め込んだ架空の .xlsx を作り、
// build.mjs → テスト用 DB に取り込み → verify.sql → compare.mjs ですべて一致することを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { createDb } from '../../supabase/tests/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const d = (s) => new Date(`${s}T00:00:00Z`);

function fixture() {
  const cm = [['customer_id', '名前', 'フリガナ', '電話番号', 'email', '生年月日', '初回訪問日', '言語', '来院のきっかけ', '住所', 'ステータス', 'notion', 'created_at', 'updated_at', 'synced_at', 'face', 'face2', 'notes']];
  const people = [
    ['P001', '旧 患者', 'キュウ', '09000000001', '', d('1970-01-01'), '', 'ja', '', '', 'archived'],
    ['P002', '紹介 する人', 'ショウカイ', '090-0000-0002', 'a@example.com', d('1980-02-02'), '', 'pt', 'Instagram,紹介', '', 'active'],
    ['P003', '紹介 された人', 'サレタ', '09000000003', '', '', '', 'en', '', '', 'active'],
    ['P004', '月二回 さん', 'ツキニ', '09000000004', '', d('1990-04-04'), '', 'es', '', '', 'active'],
    ['P005', '取消 さん', 'トリケシ', '09000000005', '', d('1991-05-05'), '', 'ja', '', '', 'active'],
    ['P010', '期限 さん', 'キゲン', '09000000010', '', d('1992-06-06'), '', 'ja', '', '', 'active'],
  ];
  for (const p of people) cm.push([...p, '', '2026-07-01T00:00:00.000Z', '', '', '', '', '']);

  const tr = [['entry_id', '種別', 'target', '施術日', 'customer_id', 'コース', '売上', '支払', 'メモ', '問診', 'クレジット', '紹介者', '集計対象', 'notion', 'created_at']];
  const rec = (n, date, cust, course, sales, pay, credit = 0, ref = '', elig = 'TRUE', type = 'record', target = '', memo = '') =>
    tr.push([u(n), type, target, d(date), cust, course, sales, pay, memo, 'FALSE', credit, ref, elig, '', `${date}T0${n % 9}:00:00.000Z`]);
  rec(1, '2026-07-05', 'P001', 'カイロプラクティック', 4000, '現金');
  rec(2, '2026-07-10', 'P002', '筋膜リリース', 5000, 'カード');
  rec(3, '2026-07-12', 'P003', 'トータルケア', 5000, '現金', 0, 'P002');                // 紹介で ¥1,000 引き
  rec(4, '2026-07-20', 'P004', '月2回コース', 10000, 'PayPay');                         // 月2回: 購入
  rec(5, '2026-07-27', 'P004', '月2回コース', 0, '');                                  // 月2回: 2 回目
  rec(6, '2026-08-03', 'P004', '月2回コース', 0, '');                                  // 購入の記録がない 2 回目
  rec(7, '2026-08-05', 'P005', '吸い玉・カッピング', 3500, '現金', 500);                // クレジット使用 → 取消
  rec(8, '2026-08-05', 'P005', '', 0, '', 0, '', 'FALSE', 'void', u(7), '【取消】');
  tr[tr.length - 1][6] = -3500;
  rec(9, '2026-08-06', 'P005', 'カイロプラクティック', 4000, '現金');
  rec(10, '2026-08-07', 'P005', 'カイロプラクティック', 4000, '現金', 0, '', 'FALSE');   // 取消行なしの集計対象外
  rec(11, '2026-08-08', 'P002', '', 0, '', 0, '', 'FALSE', 'no_show', '', 'no-show 理由: 体調不良');
  rec(12, '2026-08-09', 'P002', 'なぞのコース', 3000, '現金');                          // コース不明
  rec(13, '2026-08-10', 'P003', 'カイロプラクティック', 0, '未払い');                  // 未払い 0 円
  rec(14, '2026-08-11', 'P099', 'カイロプラクティック', 4000, '現金');                  // 顧客マスタに無い
  rec(15, '2026-09-01', 'P010', 'カイロプラクティック', 3000, '現金', 1000);            // 期限切れのクレジットを使用

  const cr = [['entry_id', '日付', 'customer_id', '種別', '金額', '有効期限', '関連', 'created_at']];
  const c = (n, date, cust, type, amount, exp, rel) => cr.push([u(100 + n), d(date), cust, type, amount, exp ? d(exp) : '', rel, `${date}T1${n % 9}:00:00.000Z`]);
  c(1, '2026-07-12', 'P002', 'grant', 1000, '2027-07-12', u(3));     // 紹介
  c(2, '2026-07-01', 'P005', 'grant', 2000, '2027-07-01', '');       // 手動の付与
  c(3, '2026-08-05', 'P005', 'use', -500, '', u(7));
  c(4, '2026-08-05', 'P005', 'refund', 500, '', u(7));              // 取消で払い戻し
  c(5, '2026-01-01', 'P010', 'grant', 1000, '2026-07-01', '');       // 期限切れ
  c(6, '2026-09-01', 'P010', 'use', -1000, '', u(15));              // 期限切れの付与を使った(現行ではあり得た)
  c(7, '2026-06-01', 'P002', 'grant', 300, '2026-08-01', '');
  c(8, '2026-08-02', 'P002', 'expire', -300, '', u(107));

  const qu = [['entry_id', 'date', 'customer_id', 'visit_type', 'has_changes', 'main_symptom', 'duration', 'pain', 'safety', 'note', 'goal', 'strength', 'disliked', 'photo', 'face', 'consent', 'consent_date', 'body', 'sig', 'notion', 'created_at', 'synced', 'err', 'raw_json']];
  qu.push([u(201), d('2026-07-10'), 'P002', 'first', '', 'shoulder_stiff,headache', 'within_month', 5, 'none', '', 'relax', 'normal', 'none', 'no', '', 'TRUE', d('2026-07-10'), 'https://drive.example/body', 'https://drive.example/sig', '', '2026-07-10T01:00:00.000Z', '', 0, JSON.stringify({ lang: 'pt', mainSymptom: ['shoulder_stiff', 'headache'], referrerName: '' })]);
  qu.push([u(202), d('2026-07-12'), 'P003', 'first', '', 'lower_back', 'over_month', 7, 'pregnant', 'メモ', 'pain_relief', 'light', 'joint_adjustment', 'yes', 'no_face', 'TRUE', d('2026-07-12'), '', '', '', '2026-07-12T01:00:00.000Z', '', 0, '']);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cm), '顧客マスタ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tr), '施術台帳');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cr), 'クレジット台帳');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(qu), '問診台帳');
  const dir = mkdtempSync(join(tmpdir(), 'lbc-migrate-'));
  const file = join(dir, 'fixture.xlsx');
  XLSX.writeFile(wb, file);
  return file;
}

test('移行: 架空シートを変換・取り込み・照合して、すべて一致する', { timeout: 120000 }, async () => {
  const file = fixture();
  const log = execFileSync(process.execPath, [join(here, 'build.mjs'), file], { encoding: 'utf8' });
  // 報告に氏名が出ていない
  for (const name of ['旧 患者', '紹介 する人', '月二回 さん', '期限 さん']) assert.ok(!log.includes(name), `報告に氏名が出ている: ${name}`);
  assert.match(log, /コース名を判別できない/);
  assert.match(log, /顧客マスタに無い/);
  assert.match(log, /購入の記録が見つからない 2 回目/);
  assert.match(log, /集計対象外/);

  const db = await createDb();
  await db.exec(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'));
  const res = await db.exec(readFileSync(join(here, 'out/import.sql'), 'utf8'));
  const result = res.at(-1).rows[0];
  assert.equal(result.alloc_fallback_uses, 1);          // 期限切れの付与を使った 1 件
  assert.equal(result.alloc_shortfall_uses, 0);
  const verify = (await db.query(readFileSync(join(here, 'verify.sql'), 'utf8'))).rows[0].verify;
  writeFileSync(join(here, 'out/actual.json'), JSON.stringify(verify));
  const cmp = (() => {
    try { return execFileSync(process.execPath, [join(here, 'compare.mjs')], { encoding: 'utf8' }); } catch (e) { return e.stdout; }
  })();
  assert.match(cmp, /すべて一致/, cmp);

  // 中身の確認
  const one = async (sql) => (await db.query(sql)).rows[0];
  assert.equal((await one(`select status from public.customers where code = 'P001'`)).status, 'archived');
  assert.equal((await one(`select lang from public.customers where code = 'P003'`)).lang, 'ja');
  assert.equal((await one(`select r.code from public.customers c join public.customers r on r.id = c.referred_by where c.code = 'P003'`)).code, 'P002');
  assert.equal((await one(`select e.reason from public.credit_entries e join public.customers c on c.id = e.customer_id where c.code = 'P002' and e.kind = 'grant' and e.amount = 1000`)).reason, 'referral');
  const p4 = await one(`select private.pass_remaining(p.id) as rem, p.valid_until::text as until from public.passes p join public.customers c on c.id = p.customer_id where c.code = 'P004'`);
  assert.deepEqual(p4, { rem: 0, until: '2026-07-31' });
  assert.equal((await one(`select count(*)::int n from public.visits v join public.customers c on c.id = v.customer_id where c.code = 'P005' and v.status = 'voided'`)).n, 2);
  assert.equal((await one(`select private.credit_available(c.id, '2026-09-30') as a from public.customers c where c.code = 'P005'`)).a, 2000);
  assert.equal((await one(`select count(*)::int n from public.customers where first_visit_date is not null`)).n, 6);
  assert.equal((await one(`select nextval('public.customer_code_seq') as n`)).n, 11);
  const q = await one(`select q.answers->'legacy_images'->>'body' as body, q.lang from public.questionnaires q join public.customers c on c.id = q.customer_id where c.code = 'P002'`);
  assert.deepEqual(q, { body: 'https://drive.example/body', lang: 'pt' });
  await db.close();
});
