import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s;
before(async () => {
  db = await createDb();
  s = await seed(db);
});

const valid = (over = {}) => {
  const request_id = uuid();
  return {
    request_id, store_id: s.store,
    name: '山田 花子', furigana: 'ヤマダ ハナコ', phone: '090-1111-2222', email: '', birth_date: '1990-04-01',
    lang: 'ja', how_found: 'instagram',
    answers: {
      main_symptom: ['shoulder_stiff', 'lower_back'], symptom_duration: 'within_month', pain_level: 6,
      safety: ['none'], treatment_goal: 'pain_relief', treatment_strength: 'normal', disliked: ['none'],
      photo_consent: 'yes', face_preference: 'no_face', consent_agreed: true,
    },
    image_paths: { signature: `q/${request_id}/signature.png`, body: `q/${request_id}/body.png` },
    ...over,
  };
};
const submit = (p) => rpc(db, null, 'submit_questionnaire', p);   // 未ログイン(お客様)として送る
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.startsWith(code), `expected ${code}`);

test('初回のお客様: 未ログインで送信でき、患者が新規登録される。返すのは受付結果だけ', async () => {
  const p = valid({ phone: '090-3333-0001' });
  const r = await submit(p);
  assert.deepEqual(r, { accepted: true });
  const c = await one(db, `select c.name, c.phone_normalized, c.birth_date::text, c.how_found, c.code
                           from public.customers c where phone_normalized = '09033330001'`);
  assert.equal(c.name, '山田 花子');
  assert.equal(c.birth_date, '1990-04-01');
  assert.deepEqual(c.how_found, ['instagram']);
  const q = await one(db, `select count(*)::int n, max(pain_areas::text) pa from public.questionnaires where phone_normalized = '09033330001'`);
  assert.equal(q.n, 1);
  assert.equal(q.pa, '{shoulder_stiff,lower_back}');
});

test('冪等性: 同じ request_id の再送は 1 件だけ', async () => {
  const p = valid({ phone: '090-3333-0002' });
  await submit(p);
  const again = await submit(p);
  assert.equal(again.duplicate, true);
  const n = await one(db, `select count(*)::int n from public.questionnaires where request_id = $1`, [p.request_id]);
  assert.equal(n.n, 1);
});

test('照合: 電話番号 + 氏名(空白・大小文字の違いは無視)が一致すれば既存の患者に紐づく', async () => {
  await submit(valid({ phone: '090-3333-0003', name: 'Silva Maria' }));
  await submit(valid({ phone: '09033330003', name: 'silva  maria', lang: 'pt' }));
  const rows = await db.query(`select id, lang from public.customers where phone_normalized = '09033330003'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].lang, 'pt');
  const n = await one(db, `select count(*)::int n from public.questionnaires where customer_id = $1`, [rows.rows[0].id]);
  assert.equal(n.n, 2);
});

test('家族で電話番号を共有: 名前が違えば別の患者として登録(誤マージしない)', async () => {
  await submit(valid({ phone: '090-3333-0004', name: '佐藤 一郎', birth_date: '1970-01-01' }));
  await submit(valid({ phone: '090-3333-0004', name: '佐藤 花子', birth_date: '1975-05-05' }));
  const rows = await db.query(`select name, birth_date::text from public.customers where phone_normalized = '09033330004' order by name`);
  assert.deepEqual(rows.rows.map((r) => r.name), ['佐藤 一郎', '佐藤 花子']);
  assert.deepEqual(rows.rows.map((r) => r.birth_date), ['1970-01-01', '1975-05-05']);
});

test('既存患者の生年月日・メールは上書きしない(空のときだけ補う)', async () => {
  await submit(valid({ phone: '090-3333-0005', name: 'Keep Me', birth_date: '1980-01-01', email: 'a@example.com' }));
  await submit(valid({ phone: '090-3333-0005', name: 'Keep Me', birth_date: '2000-12-31', email: 'b@example.com' }));
  const c = await one(db, `select birth_date::text, email from public.customers where phone_normalized = '09033330005'`);
  assert.deepEqual(c, { birth_date: '1980-01-01', email: 'a@example.com' });
});

test('入力の検証: 必須・形式・選択肢の範囲・同意・署名', async () => {
  const base = valid();
  const cases = [
    [{ name: '  ' }, 'name_invalid'],
    [{ phone: '12345' }, 'phone_invalid'],
    [{ birth_date: '2999-01-01' }, 'birth_date_invalid'],
    [{ birth_date: 'abc' }, 'birth_date_invalid'],
    [{ email: 'not-an-email' }, 'email_invalid'],
    [{ lang: 'fr' }, 'lang_invalid'],
    [{ how_found: 'tv' }, 'how_found_invalid'],
    [{ store_id: uuid() }, 'store_invalid'],
    [{ answers: { ...base.answers, main_symptom: [] } }, 'main_symptom_invalid'],
    [{ answers: { ...base.answers, main_symptom: ['hacked'] } }, 'main_symptom_invalid'],
    [{ answers: { ...base.answers, pain_level: 11 } }, 'pain_level_invalid'],
    [{ answers: { ...base.answers, safety: ['none', 'pregnant'] } }, 'safety_invalid'],
    [{ answers: { ...base.answers, disliked: [] } }, 'disliked_invalid'],
    [{ answers: { ...base.answers, photo_consent: 'yes', face_preference: '' } }, 'face_preference_invalid'],
    [{ answers: { ...base.answers, consent_agreed: false } }, 'consent_required'],
    [{ answers: { ...base.answers, safety_note: 'x'.repeat(501) } }, 'text_too_long'],
    [{ image_paths: (id) => ({ body: `q/${id}/body.png` }) }, 'signature_required'],
    [{ image_paths: { signature: `q/${uuid()}/signature.png` } }, 'image_path_invalid'],
    [{ image_paths: { signature: `../../etc/passwd` } }, 'image_path_invalid'],
    [{ image_paths: (id) => ({ signature: `q/${id}/signature.png`, extra: 'q/x' }) }, 'image_path_invalid'],
  ];
  for (const [over, code] of cases) {
    const p = valid(over);
    if (over.image_paths === undefined) p.image_paths = { signature: `q/${p.request_id}/signature.png` };
    else if (typeof over.image_paths === 'function') p.image_paths = over.image_paths(p.request_id);
    await rejects(submit(p), code);
  }
  const n = await one(db, `select count(*)::int n from public.questionnaires where phone_normalized = '09011112222'`);
  assert.equal(n.n, 0);
});

test('同じ電話番号からの送信は 1 日 5 件まで', async () => {
  for (let i = 0; i < 5; i++) await submit(valid({ phone: '090-3333-0006', name: `Spam ${i}` }));
  await rejects(submit(valid({ phone: '090-3333-0006', name: 'Spam 6' })), 'too_many_submissions');
});

test('権限: お客様(未ログイン)は問診・顧客を読めない。スタッフは自店舗の問診を読める', async () => {
  await as(db, null, async () => {
    await assert.rejects(db.query(`select * from public.questionnaires`), /permission denied/);
    await assert.rejects(db.query(`insert into public.questionnaires (store_id, customer_id, lang, answers, phone_normalized, request_id)
                                   values ($1, $2, 'ja', '{}', '0900', $3)`, [s.store, s.cust.A, uuid()]), /permission denied/);
  });
  const staffSees = await as(db, s.lucas, async () => (await one(db, `select count(*)::int n from public.questionnaires`)).n);
  assert.ok(staffSees > 0);
  const otherSees = await as(db, s.otherStaff, async () => (await one(db, `select count(*)::int n from public.questionnaires`)).n);
  assert.equal(otherSees, 0);
});

test('店舗の公開情報は名前と ID だけ', async () => {
  const r = await as(db, null, async () => (await one(db, `select public.public_store($1) as r`, [s.store])).r);
  assert.deepEqual(Object.keys(r).sort(), ['id', 'name']);
});
