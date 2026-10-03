import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seed, rpc, as, one, uuid } from './harness.mjs';

let db, s, day, staffId, otherStaffRow;

before(async () => {
  db = await createDb();
  s = await seed(db);
  // 2 週間ほど先の月曜日(テストの実行日に左右されない)
  day = (await one(db, `select (current_date + 14 + ((8 - extract(dow from current_date)::int) % 7))::text as d`)).d;
  staffId = (await one(db, `select id from public.staff where user_id = $1`, [s.lucas])).id;
  otherStaffRow = (await one(db, `select id from public.staff where user_id = $1`, [s.otherStaff])).id;
  await db.query(`insert into public.staff_schedules (store_id, staff_id, weekday, start_time, end_time)
                  values ($1, $2, 1, '10:00', '12:00')`, [s.store, staffId]);
  // 予約は一時停止中(migration 0009 で未ログインの実行権限を外している)。
  // ここでは再開したときの挙動を検証するため、テスト用 DB でだけ権限を戻す
  await db.exec(`grant execute on function public.get_available_slots(uuid, uuid, date, date, uuid), public.create_booking(jsonb),
                  public.get_booking_by_token(uuid), public.cancel_booking(jsonb) to anon`);
});

test('一時停止中: 未ログインでは予約関連の関数を呼べない(migration 0009)', async () => {
  const fresh = await createDb();
  await fresh.exec('set role anon');
  try {
    await assert.rejects(fresh.query(`select public.create_booking('{}'::jsonb)`), /permission denied/);
    await assert.rejects(fresh.query(`select * from public.get_available_slots(gen_random_uuid(), gen_random_uuid(), current_date, current_date)`), /permission denied/);
    await assert.rejects(fresh.query(`select public.cancel_booking('{}'::jsonb)`), /permission denied/);
  } finally {
    await fresh.exec('reset role');
    await fresh.close();
  }
});

const at = (d, hm) => one(db, `select (($1::date + $2::time) at time zone 'Asia/Tokyo') as t`, [d, hm]).then((r) => r.t.toISOString());
const slots = async (date, menu = s.menu.chiro, user = null) =>
  as(db, user, async () => (await db.query(`select start_at from public.get_available_slots($1, $2, $3, $3)`, [s.store, menu, date]))
    .rows.map((r) => r.start_at.toISOString()));
const book = (p, user = null) => rpc(db, user, 'create_booking', {
  request_id: uuid(), store_id: s.store, menu_id: s.menu.chiro, name: 'Booking Guest', phone: '080-1234-0000', lang: 'pt', ...p,
});
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.startsWith(code), `expected ${code}`);

test('空き時間: 10:00-12:00 の勤務・60 分のコース・30 分刻み → 10:00 / 10:30 / 11:00', async () => {
  assert.deepEqual(await slots(day), [await at(day, '10:00'), await at(day, '10:30'), await at(day, '11:00')]);
  // 勤務のない曜日(火曜)は空きなし
  const tue = (await one(db, `select ($1::date + 1)::text d`, [day])).d;
  assert.deepEqual(await slots(tue), []);
});

test('予約: 未ログインで予約でき、重なる時間帯は空きから消える。同じ枠は二重に取れない', async () => {
  const start = await at(day, '10:00');
  const r = await book({ start_at: start, phone: '080-1234-0001' });
  assert.ok(r.cancel_token);
  assert.equal(new Date(r.end_at).getTime() - new Date(r.start_at).getTime(), 60 * 60 * 1000);
  assert.deepEqual(await slots(day), [await at(day, '11:00')]);
  await rejects(book({ start_at: start, phone: '080-1234-0002', name: 'Someone Else' }), 'slot_unavailable');
  await rejects(book({ start_at: await at(day, '10:30'), phone: '080-1234-0002', name: 'Someone Else' }), 'slot_unavailable');
  // 空き時間に無い時刻(勤務外・刻みずれ)は取れない
  await rejects(book({ start_at: await at(day, '09:00'), phone: '080-1234-0003' }), 'slot_unavailable');
  await rejects(book({ start_at: await at(day, '11:15'), phone: '080-1234-0003' }), 'slot_unavailable');
});

test('DB の排他制約: 関数を通さずに重なる予約を入れようとしても入らない', async () => {
  const b = await one(db, `select * from public.bookings where status = 'confirmed' limit 1`);
  await assert.rejects(db.query(
    `insert into public.bookings (store_id, staff_id, customer_id, menu_id, period, source, request_id)
     values ($1, $2, $3, $4, tstzrange(lower($5::tstzrange) + interval '15 min', upper($5::tstzrange) + interval '15 min'), 'staff', $6)`,
    [b.store_id, b.staff_id, b.customer_id, b.menu_id, b.period, uuid()]), /bookings_no_overlap|exclusion/);
});

test('キャンセル: トークンでキャンセルすると枠が空く。二度目は重複扱い。トークンでは個人情報を返さない', async () => {
  const d2 = (await one(db, `select ($1::date + 7)::text d`, [day])).d;
  const r = await book({ start_at: await at(d2, '11:00'), phone: '080-1234-0004' });
  assert.deepEqual(await slots(d2), [await at(d2, '10:00')]);
  const info = await as(db, null, async () => (await one(db, `select public.get_booking_by_token($1) as r`, [r.cancel_token])).r);
  assert.deepEqual(Object.keys(info).sort(), ['can_cancel', 'end_at', 'menu_id', 'menu_name', 'start_at', 'status']);
  assert.equal(info.can_cancel, true);
  assert.deepEqual(await rpc(db, null, 'cancel_booking', { cancel_token: r.cancel_token }), { cancelled: true });
  assert.equal((await rpc(db, null, 'cancel_booking', { cancel_token: r.cancel_token })).duplicate, true);
  assert.equal((await slots(d2)).length, 3);
  await rejects(rpc(db, null, 'cancel_booking', { cancel_token: uuid() }), 'booking_not_found');
});

test('キャンセル締切を過ぎるとお客様はキャンセルできない(スタッフはできる)', async () => {
  const d3 = (await one(db, `select ($1::date + 14)::text d`, [day])).d;
  const r = await book({ start_at: await at(d3, '10:00'), phone: '080-1234-0005' });
  await db.query(`update public.stores set settings = settings || '{"cancel_hours": 100000}' where id = $1`, [s.store]);
  try {
    await rejects(rpc(db, null, 'cancel_booking', { cancel_token: r.cancel_token }), 'cancel_deadline_passed');
    assert.deepEqual(await rpc(db, s.lucas, 'cancel_booking', { booking_id: r.booking_id }), { cancelled: true });
    // 他店舗のスタッフはキャンセルできない
    const r2 = await book({ start_at: await at(d3, '10:00'), phone: '080-1234-0006' });
    await rejects(rpc(db, s.otherStaff, 'cancel_booking', { booking_id: r2.booking_id }), 'booking_not_found');
  } finally {
    await db.query(`update public.stores set settings = settings - 'cancel_hours' where id = $1`, [s.store]);
  }
});

test('休み: 終日休みは空きなし。時間帯の休み(10:30-11:00)は重なる開始時刻だけ消える。臨時枠は追加される', async () => {
  const d4 = (await one(db, `select ($1::date + 21)::text d`, [day])).d;
  const d5 = (await one(db, `select ($1::date + 28)::text d`, [day])).d;
  const sat = (await one(db, `select ($1::date + 26)::text d`, [day])).d;   // 土曜
  await db.query(`insert into public.schedule_exceptions (store_id, staff_id, date, kind) values ($1, $2, $3, 'off')`, [s.store, staffId, d4]);
  await db.query(`insert into public.schedule_exceptions (store_id, staff_id, date, kind, start_time, end_time)
                  values ($1, $2, $3, 'off', '10:30', '11:00')`, [s.store, staffId, d5]);
  await db.query(`insert into public.schedule_exceptions (store_id, staff_id, date, kind, start_time, end_time)
                  values ($1, $2, $3, 'extra', '14:00', '15:30')`, [s.store, staffId, sat]);
  assert.deepEqual(await slots(d4), []);
  assert.deepEqual(await slots(d5), [await at(d5, '11:00')]);
  assert.deepEqual(await slots(sat), [await at(sat, '14:00'), await at(sat, '14:30')]);
});

test('受付の期限: 直前(リードタイム内)と、受付期間より先は予約できない', async () => {
  await db.query(`update public.stores set settings = settings || '{"lead_minutes": 100000}' where id = $1`, [s.store]);
  try {
    assert.deepEqual(await slots(day), []);
  } finally {
    await db.query(`update public.stores set settings = settings - 'lead_minutes' where id = $1`, [s.store]);
  }
  await db.query(`update public.stores set settings = settings || '{"max_days_ahead": 1}' where id = $1`, [s.store]);
  try {
    assert.deepEqual(await slots(day), []);
  } finally {
    await db.query(`update public.stores set settings = settings - 'max_days_ahead' where id = $1`, [s.store]);
  }
});

test('同じ電話番号の未来の予約は 3 件まで。同じ氏名・電話は同じ患者に紐づく', async () => {
  const phone = '080-1234-0007';
  await db.query(`update public.stores set settings = settings || '{"max_days_ahead": 365}' where id = $1`, [s.store]);
  const days = [];
  for (let i = 1; i <= 4; i++) days.push((await one(db, `select ($1::date + $2 * 7)::text d`, [day, i + 4])).d);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await book({ start_at: await at(days[i], '10:00'), phone, name: 'Repeat Guest' })).booking_id);
  await rejects(book({ start_at: await at(days[3], '10:00'), phone, name: 'Repeat Guest' }), 'too_many_bookings');
  const c = await one(db, `select count(distinct customer_id)::int n from public.bookings where id = any($1::uuid[])`, [ids]);
  assert.equal(c.n, 1);
});

test('冪等性: 同じ request_id の再送は 1 件だけ', async () => {
  const d6 = (await one(db, `select ($1::date + 63)::text d`, [day])).d;
  await db.query(`update public.stores set settings = settings || '{"max_days_ahead": 365}' where id = $1`, [s.store]);
  const p = { request_id: uuid(), store_id: s.store, menu_id: s.menu.chiro, name: 'Idem', phone: '080-1234-0008', lang: 'ja', start_at: await at(d6, '10:00') };
  const a = await rpc(db, null, 'create_booking', p);
  const b = await rpc(db, null, 'create_booking', p);
  assert.equal(b.duplicate, true);
  assert.equal(b.booking_id, a.booking_id);
});

test('スタッフ: 既存の患者で予約でき(リードタイム無視)、状態を来店済みにできる', async () => {
  const d7 = (await one(db, `select ($1::date + 70)::text d`, [day])).d;
  const r = await book({ start_at: await at(d7, '11:00'), customer_id: s.cust.C, name: undefined, phone: undefined }, s.lucas);
  const b = await one(db, `select customer_id, source from public.bookings where id = $1`, [r.booking_id]);
  assert.deepEqual(b, { customer_id: s.cust.C, source: 'staff' });
  await as(db, s.lucas, () => db.query(`select public.set_booking_status($1, 'completed')`, [r.booking_id]));
  assert.equal((await one(db, `select status from public.bookings where id = $1`, [r.booking_id])).status, 'completed');
});

test('入力の検証', async () => {
  const start = await at(day, '11:00');
  await rejects(book({ start_at: start, name: ' ' }), 'name_invalid');
  await rejects(book({ start_at: start, phone: '123' }), 'phone_invalid');
  await rejects(book({ start_at: start, lang: 'fr' }), 'lang_invalid');
  await rejects(book({ start_at: start, menu_id: uuid() }), 'menu_invalid');
  await rejects(book({ start_at: 'not-a-date' }), 'input_invalid');
  await rejects(book({ start_at: start, store_id: uuid() }), 'store_invalid');
});

test('権限: 未ログインは予約・勤務枠を読めない。他店舗のスタッフは見えない。予約は直接書き換えられない', async () => {
  await as(db, null, async () => {
    await assert.rejects(db.query(`select * from public.bookings`), /permission denied/);
    await assert.rejects(db.query(`select * from public.staff_schedules`), /permission denied/);
  });
  const other = await as(db, s.otherStaff, async () => (await one(db, `select count(*)::int n from public.bookings`)).n);
  assert.equal(other, 0);
  await as(db, s.lucas, async () => {
    await assert.rejects(db.query(`update public.bookings set status = 'cancelled'`), /permission denied/);
    // スタッフ(owner でない)は通常の勤務枠を変えられない
    const n = (await db.query(`update public.staff_schedules set end_time = '20:00' returning id`)).rows.length;
    assert.equal(n, 0);
  });
  void otherStaffRow;
});
