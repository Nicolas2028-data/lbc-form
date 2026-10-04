// カルテ(Notion の置き換え): 受付・カルテメモ・写真・今日の一覧・カルテ一覧
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s;
before(async () => {
  db = await createDb();
  s = await seed(db);
});

const newCustomer = async (name) => (await one(db, `insert into public.customers (name) values ($1) returning id`, [name])).id;
const record = (user, p) => rpc(db, user, 'record_visit', { request_id: uuid(), payment_method: 'cash', menu_id: s.menu.chiro, ...p });
const day = (user, date = null) => as(db, user, async () => (await one(db, `select public.get_day($1::date) as r`, [date])).r);
const q = (user, sql, params = []) => as(db, user, async () => (await db.query(sql, params)).rows);
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.includes(code), `expected ${code}`);
const today = async () => (await one(db, `select private.store_today($1)::text d`, [s.store])).d;

test('受付: 未記録で今日の一覧に出て、二度押ししても 1 件。記録すると完了になる。「前回から変化」は記録で選んだ値(外せば空)', async () => {
  const c = await newCustomer('受付 太郎');
  const a = await rpc(db, s.lucas, 'checkin', { customer_id: c });
  const b = await rpc(db, s.lucas, 'checkin', { customer_id: c, change_from_last: 'changed' });
  assert.equal(a.existing, false);
  assert.equal(b.existing, true);
  assert.equal(a.id, b.id);
  let d = await day(s.lucas);
  let mine = d.items.filter((i) => i.customer.id === c);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'waiting');
  assert.equal(mine[0].change_from_last, 'changed');
  assert.equal(mine[0].is_first, true);

  // 画面で外して記録した → 受付の値で上書きされない
  const r = await record(s.lucas, { customer_id: c, change_from_last: null });
  const v = await one(db, `select change_from_last from public.visits where id = $1`, [r.visit_id]);
  assert.equal(v.change_from_last, null);
  d = await day(s.lucas);
  mine = d.items.filter((i) => i.customer.id === c);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'done');
  assert.equal(mine[0].visit.total, 4000);
});

test('受付なしで記録した人も今日の一覧に出る。未記録が一番上', async () => {
  const done = await newCustomer('直接 記録');
  const wait = await newCustomer('待ち 花子');
  await record(s.lucas, { customer_id: done });
  await rpc(db, s.lucas, 'checkin', { customer_id: wait });
  const d = await day(s.lucas);
  assert.equal(d.items[0].state, 'waiting');
  assert.ok(d.items.some((i) => i.customer.id === done && i.state === 'done' && i.checkin_id === null));
});

test('取消して記録し直すと、受付は新しい記録に付け替わり、一覧は 1 行のまま', async () => {
  const c = await newCustomer('訂正 さん');
  await rpc(db, s.lucas, 'checkin', { customer_id: c });
  const r1 = await record(s.lucas, { customer_id: c });
  await rpc(db, s.lucas, 'void_visit', { request_id: uuid(), visit_id: r1.visit_id, reason: '入力ミス' });
  let mine = (await day(s.lucas)).items.filter((i) => i.customer.id === c);
  assert.deepEqual(mine.map((i) => i.state), ['voided']);
  const r2 = await record(s.lucas, { customer_id: c, menu_id: s.menu.fascia, allow_same_day: true });
  mine = (await day(s.lucas)).items.filter((i) => i.customer.id === c);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'done');
  assert.equal(mine[0].visit.id, r2.visit_id);
});

test('施術なしの記録は no_show として完了。受付の取消は未記録のものだけ', async () => {
  const c = await newCustomer('取消 受付');
  const ck = await rpc(db, s.lucas, 'checkin', { customer_id: c });
  await rpc(db, s.lucas, 'cancel_checkin', { checkin_id: ck.id });
  assert.equal((await day(s.lucas)).items.filter((i) => i.customer.id === c).length, 0);

  const c2 = await newCustomer('施術なし');
  const ck2 = await rpc(db, s.lucas, 'checkin', { customer_id: c2 });
  await record(s.lucas, { customer_id: c2, attended: false, no_show_reason: '体調不良', menu_id: null, payment_method: null });
  assert.equal((await day(s.lucas)).items.find((i) => i.customer.id === c2).state, 'no_show');
  await rejects(rpc(db, s.lucas, 'cancel_checkin', { checkin_id: ck2.id }), 'checkin_already_recorded');
});

test('受付: ほかの店舗のスタッフ・ログインしていない人はできない。受付の行は自分の店舗の分しか見えない', async () => {
  const c = await newCustomer('他店 確認');
  const ck = await rpc(db, s.lucas, 'checkin', { customer_id: c });
  await rejects(rpc(db, s.otherStaff, 'cancel_checkin', { checkin_id: ck.id }), 'checkin_not_found');
  await rejects(rpc(db, null, 'checkin', { customer_id: c }), 'permission denied');
  assert.equal((await q(s.otherStaff, `select * from public.checkins where id = $1`, [ck.id])).length, 0);
  assert.equal((await day(s.otherStaff)).items.filter((i) => i.customer.id === c).length, 0);
  // 直接書き込みはできない(受付は関数からだけ)
  await rejects(q(s.lucas, `insert into public.checkins (store_id, customer_id, checkin_date) values ($1, $2, current_date)`, [s.store, c]), 'permission denied');
});

test('問診票(当日)が届くと自動で受付される', async () => {
  const request_id = uuid();
  await rpc(db, null, 'submit_questionnaire', {
    request_id, store_id: s.store, name: '問診 次郎', furigana: 'モンシン ジロウ', phone: '090-7777-0001', email: '',
    birth_date: '1990-01-01', lang: 'pt', how_found: 'instagram',
    answers: {
      main_symptom: ['lower_back'], symptom_duration: 'within_month', pain_level: 5, safety: ['none'],
      treatment_goal: 'pain_relief', treatment_strength: 'normal', disliked: ['none'],
      photo_consent: 'yes', face_preference: 'no_face', consent_agreed: true,
    },
    image_paths: { signature: `q/${request_id}/signature.png` },
  });
  const c = await one(db, `select id from public.customers where phone_normalized = '09077770001'`);
  const item = (await day(s.lucas)).items.find((i) => i.customer.id === c.id);
  assert.equal(item.state, 'waiting');
  assert.equal(item.source, 'questionnaire');
});

test('カルテメモ: 書いた人が自動で入り、直すと前の内容が残る。消しても行は残り、消したものは直せない', async () => {
  const c = await newCustomer('メモ さん');
  const r = await record(s.lucas, { customer_id: c });
  const [n] = await q(s.lucas,
    `insert into public.chart_notes (store_id, customer_id, visit_id, body) values ($1, $2, $3, '右肩の可動域が改善') returning id, created_by`,
    [s.store, c, r.visit_id]);
  const lucasStaff = await one(db, `select id from public.staff where user_id = $1`, [s.lucas]);
  assert.equal(n.created_by, lucasStaff.id);

  await q(s.owner, `update public.chart_notes set body = '右肩の可動域が改善。次回は腰も' where id = $1`, [n.id]);
  const after = await one(db, `select body, updated_by, created_by from public.chart_notes where id = $1`, [n.id]);
  assert.equal(after.body, '右肩の可動域が改善。次回は腰も');
  assert.equal(after.created_by, lucasStaff.id);
  assert.notEqual(after.updated_by, lucasStaff.id);
  const rev = await db.query(`select body from private.chart_note_revisions where note_id = $1`, [n.id]);
  assert.deepEqual(rev.rows.map((x) => x.body), ['右肩の可動域が改善']);

  await q(s.lucas, `update public.chart_notes set deleted_at = '2000-01-01' where id = $1`, [n.id]);
  const del = await one(db, `select deleted_at > now() - interval '1 minute' as recent from public.chart_notes where id = $1`, [n.id]);
  assert.equal(del.recent, true);   // 時刻はサーバーが入れる
  await rejects(q(s.lucas, `update public.chart_notes set body = 'x' where id = $1`, [n.id]), 'chart_note_deleted');
  // 物理削除はできない
  await rejects(q(s.lucas, `delete from public.chart_notes where id = $1`, [n.id]), 'permission denied');
});

test('カルテメモ: 患者・来院の付け替えや、ほかの患者の来院への書き込みはできない。ほかの店舗からは見えない', async () => {
  const c = await newCustomer('付け替え');
  const other = await newCustomer('別人');
  const r = await record(s.lucas, { customer_id: c });
  await rejects(q(s.lucas, `insert into public.chart_notes (store_id, customer_id, visit_id, body) values ($1, $2, $3, 'x')`,
    [s.store, other, r.visit_id]), 'visit_mismatch');
  const [n] = await q(s.lucas, `insert into public.chart_notes (store_id, customer_id, body, pinned) values ($1, $2, '金属アレルギー', true) returning id`, [s.store, c]);
  await rejects(q(s.lucas, `update public.chart_notes set customer_id = $2 where id = $1`, [n.id, other]), 'permission denied');
  await rejects(q(s.otherStaff, `insert into public.chart_notes (store_id, customer_id, body) values ($1, $2, 'x')`, [s.store, c]), 'row-level security');
  assert.equal((await q(s.otherStaff, `select * from public.chart_notes where id = $1`, [n.id])).length, 0);
  await rejects(q(null, `select * from public.chart_notes`), 'permission denied');
  // 空のメモは保存できない
  await rejects(q(s.lucas, `insert into public.chart_notes (store_id, customer_id, body) values ($1, $2, '   ')`, [s.store, c]), 'check constraint');
});

test('カルテ写真: 保存場所は店舗/患者/写真ID に固定。消すと消した人と時刻が入る', async () => {
  const c = await newCustomer('写真 さん');
  const r = await record(s.lucas, { customer_id: c });
  const id = uuid();
  await q(s.lucas, `insert into public.chart_photos (id, store_id, customer_id, visit_id, path) values ($1, $2, $3, $4, $5)`,
    [id, s.store, c, r.visit_id, `${s.store}/${c}/${id}.jpg`]);
  const bad = uuid();
  await rejects(q(s.lucas, `insert into public.chart_photos (id, store_id, customer_id, path) values ($1, $2, $3, $4)`,
    [bad, s.store, c, `${s.store}/${s.cust.A}/${bad}.jpg`]), 'check constraint');
  await q(s.lucas, `update public.chart_photos set deleted_at = now() where id = $1`, [id]);
  const p = await one(db, `select deleted_by is not null as by from public.chart_photos where id = $1`, [id]);
  assert.equal(p.by, true);
  const d = (await day(s.lucas)).items.find((i) => i.customer.id === c);
  assert.equal(d.photos, 0);
});

test('カルテ一覧: 期間とキーワード(患者名・メモ・カルテメモ)で探せる。前回来院からの日数が付く', async () => {
  const c = await newCustomer('一覧 検索子');
  await db.query(`update public.customers set furigana = 'イチラン ケンサクコ' where id = $1`, [c]);
  const d0 = await today();
  // 過去の来院(移行データ相当)を直接入れる
  const past = (await one(db,
    `insert into public.visits (store_id, customer_id, visit_date, attended, menu_id, request_id)
     values ($1, $2, $3::date - 14, true, $4, gen_random_uuid()) returning id`, [s.store, c, d0, s.menu.chiro])).id;
  const r = await record(s.lucas, { customer_id: c, memo: '首の張り' });
  await q(s.lucas, `insert into public.chart_notes (store_id, customer_id, visit_id, body) values ($1, $2, $3, '頸椎の調整を中心に')`, [s.store, c, r.visit_id]);
  const list = (p) => q(s.lucas, `select * from public.list_visits($1::date - 30, $1::date, $2)`, [d0, p]);

  const byName = await list('けんさくこ');   // ひらがなでもカタカナでも
  assert.deepEqual(byName.map((x) => x.id), [r.visit_id, past]);
  assert.equal(byName[0].days_since_prev, 14);
  assert.equal(byName[0].note_excerpt, '頸椎の調整を中心に');
  assert.equal((await list('頸椎')).map((x) => x.id).join(), r.visit_id);
  assert.equal((await list('首の張り')).map((x) => x.id).join(), r.visit_id);
  assert.equal((await list('100%')).length, 0);   // % や _ は文字として扱う
  await rejects(q(s.lucas, `select * from public.list_visits('2026-01-01', '2025-01-01')`), 'invalid_range');
  assert.equal((await q(s.otherStaff, `select * from public.list_visits($1::date - 30, $1::date, '')`, [d0])).filter((x) => x.customer_id === c).length, 0);
});

// ── レビュー指摘(0014)──
test('記録済みの人の受付: 既定は拒否(未記録が残らない)。同じ日の 2 回目と明示すれば受付できる', async () => {
  const c = await newCustomer('記録済み 受付');
  await record(s.lucas, { customer_id: c });
  await rejects(rpc(db, s.lucas, 'checkin', { customer_id: c }), 'already_recorded_today');
  assert.deepEqual((await day(s.lucas)).items.filter((i) => i.customer.id === c).map((i) => i.state), ['done']);
  const ck = await rpc(db, s.lucas, 'checkin', { customer_id: c, second_visit: true });
  assert.equal(ck.existing, false);
  assert.deepEqual((await day(s.lucas)).items.filter((i) => i.customer.id === c).map((i) => i.state).sort(), ['done', 'waiting']);
});

test('「前回から変化」は受付 ID で変える。記録が付いた受付は変えられない(古い画面から押しても新しい受付ができない)', async () => {
  const c = await newCustomer('変化 ボタン');
  const ck = await rpc(db, s.lucas, 'checkin', { customer_id: c });
  await rpc(db, s.lucas, 'checkin', { checkin_id: ck.id, change_from_last: 'changed' });
  await rpc(db, s.lucas, 'checkin', { checkin_id: ck.id, change_from_last: null });   // 外す
  assert.equal((await one(db, `select change_from_last from public.checkins where id = $1`, [ck.id])).change_from_last, null);
  await record(s.lucas, { customer_id: c });
  await rejects(rpc(db, s.lucas, 'checkin', { checkin_id: ck.id, change_from_last: 'none' }), 'checkin_not_found');
  assert.equal((await one(db, `select count(*)::int n from public.checkins where customer_id = $1`, [c])).n, 1);
  await rejects(rpc(db, s.otherStaff, 'checkin', { checkin_id: ck.id, change_from_last: 'none' }), 'checkin_not_found');
});

test('取消のあとに受付し直しても、受付は 1 件のまま使い回され、記録し直すと一覧は 1 行', async () => {
  const c = await newCustomer('取消後 受付');
  await rpc(db, s.lucas, 'checkin', { customer_id: c });
  const r1 = await record(s.lucas, { customer_id: c });
  await rpc(db, s.lucas, 'void_visit', { request_id: uuid(), visit_id: r1.visit_id, reason: 'x' });
  const again = await rpc(db, s.lucas, 'checkin', { customer_id: c, change_from_last: 'changed' });
  assert.equal(again.existing, true);
  await record(s.lucas, { customer_id: c, allow_same_day: true });
  const mine = (await day(s.lucas)).items.filter((i) => i.customer.id === c);
  assert.deepEqual(mine.map((i) => i.state), ['done']);
});

test('受付なしで記録 → 取消 → 受付: 取消した記録も一覧に残り、受付は未記録で出る', async () => {
  const c = await newCustomer('取消 そのまま');
  const r = await record(s.lucas, { customer_id: c });
  await rpc(db, s.lucas, 'void_visit', { request_id: uuid(), visit_id: r.visit_id, reason: 'x' });
  await rpc(db, s.lucas, 'checkin', { customer_id: c });
  const states = (await day(s.lucas)).items.filter((i) => i.customer.id === c).map((i) => i.state).sort();
  assert.deepEqual(states, ['voided', 'waiting']);
});

test('移行した過去の問診(legacy_images あり)は、今日の日付でも受付しない', async () => {
  const c = await newCustomer('移行 問診');
  await db.query(`insert into public.questionnaires (store_id, customer_id, lang, answers, phone_normalized, request_id)
                  values ($1, $2, 'ja', '{"legacy_images": {}}', '', gen_random_uuid())`, [s.store, c]);
  assert.equal((await one(db, `select count(*)::int n from public.checkins where customer_id = $1`, [c])).n, 0);
});
