// ロジックのファズテスト: ランダムな操作列を DB とモデル(fuzz-model.mjs)の両方に流し、
// 1 操作ごとに結果と状態を突き合わせる。エラーにならない「計算・集計の誤り」を見つけるのが目的。
//
//   FUZZ_SCENARIOS=300 FUZZ_STEPS=40 node --test supabase/tests/fuzz.test.mjs
//   FUZZ_SEED=12345 で特定シナリオだけ再現
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';
import { Model, ModelError, addDays, endOfMonth } from './fuzz-model.mjs';

const SCENARIOS = Number(process.env.FUZZ_SCENARIOS ?? 300);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const ONLY_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;

function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p) => next() < p,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

const uuid = () => crypto.randomUUID();

// テスト専用: 「今日」を外から指定できるようにする(本番の migration には入れない)
const TODAY_OVERRIDE = `
  create or replace function private.store_today(p_store uuid) returns date
  language sql stable security definer set search_path = '' as $$
    select coalesce(nullif(current_setting('test.today', true), '')::date, (now() at time zone 'Asia/Tokyo')::date)
  $$;`;

async function call(db, user, fn, payload) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
  try {
    const r = await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)]);
    return { ok: true, data: r.rows[0].r };
  } catch (e) {
    return { ok: false, code: e.message, sqlstate: e.code };
  } finally {
    await db.exec(`reset role`);
  }
}

async function q(db, sql, params = []) { return (await db.query(sql, params)).rows; }

class Scenario {
  constructor(db, seed) {
    this.db = db;
    this.seed = seed;
    this.r = rng(seed);
    this.m = new Model();
    this.log = [];
    this.findings = [];      // ロジックの食い違い(テスト失敗)
    this.warnings = [];      // 仕様として要確認の挙動
    this.today = addDays('2026-10-01', this.r.int(0, 60));
  }

  async setup() {
    const { db } = this;
    this.owner = uuid();
    this.staff = uuid();
    await db.query(`insert into auth.users (id) values ($1), ($2)`, [this.owner, this.staff]);
    this.store = (await q(db, `insert into public.stores (name) values ($1) returning id`, [`fuzz-${this.seed}`]))[0].id;
    await db.query(`insert into public.staff (user_id, store_id, role, display_name) values
      ($1, $3, 'owner', 'o'), ($2, $3, 'staff', 's')`, [this.owner, this.staff, this.store]);
    for (const [code, price] of [['chiro', 4000], ['fascia', 5000], ['total', 6000], ['mini', 800]]) {
      const id = (await q(db, `insert into public.menus (store_id, code, name, price) values ($1, $2, '{}', $3) returning id`,
        [this.store, code, price]))[0].id;
      this.m.menus.set(id, { price });
    }
    for (const [code, price, uses, validity, days] of [
      ['monthly2', 10000, 2, 'end_of_month', null], ['ticket5', 18000, 5, 'days', 30],
    ]) {
      const id = (await q(db, `insert into public.products (store_id, code, kind, name, price, uses, validity, valid_days)
        values ($1, $2, 'ticket', '{}', $3, $4, $5, $6) returning id`, [this.store, code, price, uses, validity, days]))[0].id;
      this.m.products.set(id, { price, uses, validity, validDays: days });
    }
    for (let i = 0; i < 6; i++) {
      const id = (await q(db, `insert into public.customers (name) values ($1) returning id`, [`C${this.seed}-${i}`]))[0].id;
      this.m.customers.set(id, { id, referredBy: null });
    }
    this.customerIds = [...this.m.customers.keys()];
    this.payloads = [];   // 成功した書き込み(再送テスト用)
  }

  async setToday(d) {
    this.today = d;
    await this.db.query(`select set_config('test.today', $1, false)`, [d]);
  }

  finding(kind, detail) {
    this.findings.push({ seed: this.seed, kind, detail, today: this.today, log: this.log.slice(-8) });
  }

  // DB とモデルの結果を突き合わせる。食い違えば finding を記録して false
  compare(label, predicted, res) {
    if (predicted.error) {
      if (res.ok) { this.finding('db-accepted-model-rejected', `${label}: model=${predicted.error}, db=ok ${JSON.stringify(res.data)}`); return false; }
      if (res.code !== predicted.error) { this.finding('different-error', `${label}: model=${predicted.error}, db=${res.code}`); return false; }
      return true;
    }
    if (!res.ok) { this.finding('db-rejected-model-accepted', `${label}: db=${res.code} (${res.sqlstate})`); return false; }
    return true;
  }

  predict(fn) {
    try { return fn(); } catch (e) { if (e instanceof ModelError) return { error: e.code }; throw e; }
  }

  // ── 操作 ──
  randomRecordPayload() {
    const { r, m } = this;
    const c = r.pick(this.customerIds);
    const vd = r.next();
    const visitDate = vd < 0.1 ? addDays(this.today, -1) : vd < 0.13 ? addDays(this.today, -2) : vd < 0.15 ? addDays(this.today, 1) : null;
    const today = visitDate ?? this.today;
    const hasToday = m.visitsOf(c).some((v) => v.date === today && v.status === 'recorded');
    const p = {
      request_id: uuid(), customer_id: c,
      attended: r.chance(0.9),
      allow_same_day: hasToday ? r.chance(0.5) : r.chance(0.05),
      memo: r.chance(0.3) ? 'memo' : '',
    };
    if (visitDate) p.visit_date = visitDate;
    if (!p.attended) { p.no_show_reason = r.chance(0.85) ? '体調不良' : ' '; return p; }
    p.menu_id = r.chance(0.97) ? r.pick([...m.menus.keys()]) : uuid();
    const passes = [...m.passes.values()];
    if (passes.length && r.chance(0.3)) {
      const own = passes.filter((x) => x.customer === c);
      p.use_pass_id = (own.length && r.chance(0.85) ? r.pick(own) : r.pick(passes)).id;
    }
    if (r.chance(0.18)) {
      p.purchase_product_id = r.chance(0.95) ? r.pick([...m.products.keys()]) : uuid();
      p.use_purchased_pass = r.chance(0.5);
    }
    if (r.chance(0.2)) p.referrer_id = r.chance(0.15) ? c : r.pick(this.customerIds);
    if (r.chance(0.35)) {
      const avail = m.available(c, today);
      p.credit_use = r.pick([500, 1000, avail, avail + 500, 3000, 4000, 800, -100, 0]);
    }
    p.payment_method = r.chance(0.92) ? r.pick(['cash', 'card', 'paypay', 'unpaid', 'other']) : null;
    return p;
  }

  async opRecord(p = this.randomRecordPayload()) {
    const user = this.r.chance(0.7) ? this.staff : this.owner;
    const pred = this.predict(() => this.m.predictRecord(p, this.today));
    const res = await call(this.db, user, 'record_visit', p);
    this.log.push({ op: 'record', today: this.today, p, pred: pred.error ?? { total: pred.total }, res: res.ok ? res.data : res.code });
    if (!this.compare('record', pred, res) || pred.error) return null;
    if (pred.duplicate) return null;
    const d = res.data;
    if (d.total !== pred.total) { this.finding('wrong-total', `record total: model=${pred.total}, db=${d.total}`); return null; }
    if (pred.attended && !!d.referral_limit_reached !== pred.limitReached) {
      this.finding('wrong-referral-limit', `model=${pred.limitReached}, db=${d.referral_limit_reached}`);
      return null;
    }
    const visit = this.m.applyRecord(p, pred, d);
    if (pred.attended && d.credit_available !== this.m.available(p.customer_id, pred.date)) {
      this.finding('wrong-credit-after-record', `model=${this.m.available(p.customer_id, pred.date)}, db=${d.credit_available}`);
    }
    // 紹介割引が料金の中で使い切れなかった(割引が無駄になった)
    if (pred.discount > 0 && pred.menuCharge + pred.productCharge < pred.discount) {
      this.warnings.push({ kind: 'referral-discount-wasted', detail: `料金 ${pred.menuCharge + pred.productCharge} 円に紹介割引 1000 円` });
    }
    this.payloads.push({ fn: 'record_visit', p, user, visitId: visit.id });
    return visit;
  }

  async opVoid(visit = null, forceToday = false) {
    const { r, m } = this;
    const visits = [...m.visits.values()];
    if (!visit && !visits.length) return;
    const v = visit ?? (r.chance(0.6) ? r.pick(visits.filter((x) => x.status === 'recorded').concat(visits)) : r.pick(visits));
    const isOwner = forceToday ? false : r.chance(0.4);
    const p = { request_id: uuid(), visit_id: v.id, reason: forceToday || r.chance(0.95) ? '入力ミス' : '' };
    const pred = this.predict(() => m.predictVoid(p, this.today, isOwner));
    const res = await call(this.db, isOwner ? this.owner : this.staff, 'void_visit', p);
    this.log.push({ op: 'void', today: this.today, p, isOwner, pred: pred.error ?? 'ok', res: res.ok ? res.data : res.code });
    if (!this.compare('void', pred, res) || pred.error || pred.duplicate) return;
    m.applyVoid(p, pred, this.today);
    this.payloads.push({ fn: 'void_visit', p, user: isOwner ? this.owner : this.staff });
  }

  async opReplay() {
    if (!this.payloads.length) return;
    const { fn, p, user, visitId } = this.r.pick(this.payloads);
    const before = await this.snapshotCounts();
    const res = await call(this.db, user, fn, p);
    this.log.push({ op: 'replay', fn, today: this.today, res: res.ok ? res.data : res.code });
    if (!res.ok) { this.finding('replay-failed', `${fn} の再送がエラー: ${res.code}`); return; }
    if (res.data.duplicate !== true) this.finding('replay-not-duplicate', `${fn} の再送が新規扱い`);
    if (fn === 'record_visit' && res.data.visit_id !== visitId) this.finding('replay-different-visit', `${res.data.visit_id} != ${visitId}`);
    const after = await this.snapshotCounts();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.finding('replay-changed-data', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }

  // 記録してすぐ取り消すと、何もしなかったのと同じ状態に戻るはず(モデルに頼らない検査)
  async opRecordThenVoid() {
    const p = this.randomRecordPayload();
    p.allow_same_day = true;
    const before = await this.observable(p);
    const visit = await this.opRecord(p);
    if (!visit) return;
    await this.opVoid(visit, true);
    if (this.m.visits.get(visit.id)?.status !== 'voided') return;
    const after = await this.observable(p);
    for (const k of Object.keys(before)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        this.finding('record-void-not-noop', `${k}: 記録前=${JSON.stringify(before[k])} 取消後=${JSON.stringify(after[k])}`);
      }
    }
  }

  async observable(p) {
    const { db } = this;
    const ids = [p.customer_id, p.referrer_id].filter(Boolean);
    const out = {};
    for (const id of ids) {
      out[`credit_available:${id.slice(0, 4)}`] = (await q(db, `select private.credit_available($1, $2::date) as v`, [id, this.today]))[0].v;
      out[`first_visit:${id.slice(0, 4)}`] = (await q(db,
        `select not exists (select 1 from public.visits where customer_id = $1 and attended and status = 'recorded') as v`, [id]))[0].v;
    }
    out.passes = await q(db, `select p.id, private.pass_remaining(p.id) as rem, p.status from public.passes p
      where p.customer_id = $1 and p.status = 'active' order by p.id`, [p.customer_id]);
    // すべて 0 の月(記録→取消で行だけ残る)は見た目だけの差なので比較から外す
    out.stats = await q(db, `select month::text, visits, new_customers, sales_total, unpaid_total from public.v_monthly_stats
      where store_id = $1 and (visits, new_customers, sales_total, unpaid_total) <> (0, 0, 0, 0) order by month`, [this.store]);
    return out;
  }

  async opAdvance() {
    const { r } = this;
    const d = r.chance(0.15) ? endOfMonth(this.today) : r.chance(0.05) ? addDays(this.today, 40) : addDays(this.today, r.int(0, 6));
    await this.setToday(d);
    this.log.push({ op: 'advance', today: d });
  }

  async opExpire() {
    await this.db.exec(`set role service_role`);
    try { await this.db.query(`select public.expire_credits($1::date)`, [this.today]); } finally { await this.db.exec(`reset role`); }
    this.m.applyExpire(this.today);
    this.log.push({ op: 'expire', today: this.today });
  }

  async opGrant() {
    const c = this.r.pick(this.customerIds);
    const amount = this.r.pick([500, 1000, 1500, 3000]);
    const expires = addDays(this.today, this.r.int(1, 60));
    await this.db.query(`insert into public.credit_entries (customer_id, kind, amount, reason, expires_on, occurred_on)
      values ($1, 'grant', $2, 'manual', $3, $4)`, [c, amount, expires, this.today]);
    this.m.manualGrant(c, amount, expires);
    this.log.push({ op: 'grant', c: c.slice(0, 4), amount, expires });
  }

  async snapshotCounts() {
    return (await q(this.db, `select
      (select count(*)::int from public.visits) v, (select count(*)::int from public.sales) s,
      (select count(*)::int from public.credit_entries) c, (select count(*)::int from public.pass_uses) u,
      (select count(*)::int from public.passes) p`))[0];
  }

  // ── 不変条件(毎操作後)──
  async checkInvariants() {
    const { db, m } = this;
    for (const c of this.customerIds) {
      const [row] = await q(db, `select coalesce(sum(amount), 0)::int as bal, private.credit_available($1, $2::date) as avail
        from public.credit_entries where customer_id = $1`, [c, this.today]);
      if (row.bal !== m.balance(c)) this.finding('credit-balance', `customer ${c.slice(0, 4)}: model=${m.balance(c)}, db=${row.bal}`);
      const avail = m.available(c, this.today);
      if (row.avail !== avail) this.finding('credit-available', `customer ${c.slice(0, 4)}: model=${avail}, db=${row.avail}`);
      if (row.bal < 0) this.warnings.push({ kind: 'negative-credit-balance', detail: `残高 ${row.bal} 円(紹介元の来店取消で、使用済みの紹介クレジットが打ち消された等)` });
      const firstExp = m.visitsOf(c).filter((v) => v.attended && v.status === 'recorded').map((v) => v.date).sort()[0] ?? null;
      const [fv] = await q(db, `select first_visit_date::text as d from public.customers where id = $1`, [c]);
      if (fv.d !== firstExp) this.finding('first-visit-date', `customer ${c.slice(0, 4)}: model=${firstExp}, db=${fv.d}`);
      const grants = m.referralGrants(c);
      if (grants > 3) this.finding('referral-over-limit', `customer ${c.slice(0, 4)}: ${grants} 件`);
    }
    for (const ps of m.passes.values()) {
      const [row] = await q(db, `select private.pass_remaining($1) as rem, status from public.passes where id = $1`, [ps.id]);
      const rem = m.passRemaining(ps);
      if (row.rem !== rem || row.status !== ps.status) this.finding('pass-state', `model=${rem}/${ps.status}, db=${row.rem}/${row.status}`);
      if (row.rem < 0 || row.rem > ps.total) this.finding('pass-out-of-range', `remaining=${row.rem} total=${ps.total}`);
    }
    for (const v of m.visits.values()) {
      const [row] = await q(db, `select v.status, coalesce((select sum(amount) from public.sales s where s.visit_id = v.id), 0)::int as net
        from public.visits v where v.id = $1`, [v.id]);
      const net = v.status === 'voided' ? 0 : v.total;
      if (row.status !== v.status || row.net !== net) this.finding('visit-money', `model=${v.status}/${net}, db=${row.status}/${row.net}`);
    }
    // 同じ患者・同じ日に有効な記録が複数あるのは「もう 1 件」を指定したときだけ(モデルの visits と一致すること)
    const dup = await q(db, `select customer_id, visit_date::text, count(*)::int n from public.visits v
      join public.customers c on c.id = v.customer_id
      where v.store_id = $1 and v.status = 'recorded' group by 1, 2 having count(*) > 1`, [this.store]);
    for (const d of dup) {
      const n = [...m.visits.values()].filter((v) => v.customer === d.customer_id && v.date === d.visit_date && v.status === 'recorded').length;
      if (n !== d.n) this.finding('same-day-count', `model=${n}, db=${d.n}`);
    }
    // クレジットの割当(モデルに頼らない検査)
    const ids = this.customerIds;
    const badAlloc = await q(db, `select count(*)::int n from public.credit_allocations a
      join public.credit_entries u on u.id = a.use_id join public.credit_entries g on g.id = a.grant_id
      where u.customer_id = any($1::uuid[]) and (g.expires_on < u.occurred_on or g.customer_id <> u.customer_id)`, [ids]);
    if (badAlloc[0].n) this.finding('alloc-to-expired-grant', `${badAlloc[0].n} 件`);
    const over = await q(db, `select g.id, g.amount, sum(a.amount)::int used from public.credit_entries g
      join public.credit_allocations a on a.grant_id = g.id
      where g.customer_id = any($1::uuid[])
        and not exists (select 1 from public.credit_entries v where v.reverses_id = a.use_id and v.kind = 'void')
      group by g.id, g.amount having sum(a.amount) > g.amount`, [ids]);
    if (over.length) this.finding('grant-over-allocated', JSON.stringify(over[0]));
    const mismatch = await q(db, `select u.id, -u.amount as want, coalesce(sum(a.amount), 0)::int got from public.credit_entries u
      left join public.credit_allocations a on a.use_id = u.id
      where u.customer_id = any($1::uuid[]) and u.kind = 'use' group by u.id, u.amount
      having coalesce(sum(a.amount), 0) <> -u.amount`, [ids]);
    if (mismatch.length) this.finding('use-allocation-mismatch', JSON.stringify(mismatch[0]));
    await this.checkStats();
  }

  async checkStats() {
    const rows = await q(this.db, `select month::text, visits, new_customers, sales_total, unpaid_total, avg_per_visit
      from public.v_monthly_stats where store_id = $1`, [this.store]);
    const exp = this.m.expectedStats();
    const got = Object.fromEntries(rows.map((r) => [r.month, r]));
    for (const k of new Set([...Object.keys(exp), ...Object.keys(got)])) {
      const e = exp[k];
      const g = got[k];
      if (!e || !g) { this.finding('stats-month-missing', `${k}: model=${!!e}, db=${!!g}`); continue; }
      const pairs = [['visits', e.visits, g.visits], ['new_customers', e.newCustomers, g.new_customers],
        ['sales_total', e.sales, g.sales_total], ['unpaid_total', e.unpaid, g.unpaid_total], ['avg_per_visit', e.avg, g.avg_per_visit]];
      for (const [name, a, b] of pairs) {
        if (a !== b) this.finding(`stats-${name}`, `${k}: model=${a}, db=${b}`);
      }
    }
  }

  async checkPatientCard() {
    const c = this.r.pick(this.customerIds);
    await this.db.exec(`set role authenticated`);
    await this.db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [this.staff]);
    let card;
    try { card = (await q(this.db, `select public.get_patient_card($1, $2) as r`, [c, this.store]))[0].r; }
    finally { await this.db.exec(`reset role`); }
    const m = this.m;
    const recorded = m.visitsOf(c).filter((v) => v.attended && v.status === 'recorded');
    const exp = {
      visit_count: recorded.length,
      is_first_visit: recorded.length === 0,
      credit_available: m.available(c, this.today),
      passes: [...m.passes.values()]
        .filter((p) => p.customer === c && p.status === 'active' && this.today >= p.validFrom && this.today <= p.validUntil && m.passRemaining(p) > 0)
        .map((p) => `${p.id}:${m.passRemaining(p)}`).sort(),
    };
    const got = {
      visit_count: card.visit_count, is_first_visit: card.is_first_visit, credit_available: card.credit_available,
      passes: card.passes.map((p) => `${p.id}:${p.remaining}`).sort(),
    };
    if (JSON.stringify(exp) !== JSON.stringify(got)) this.finding('patient-card', `model=${JSON.stringify(exp)} db=${JSON.stringify(got)}`);
  }

  async run(steps) {
    await this.setup();
    await this.setToday(this.today);
    for (let i = 0; i < steps && !this.findings.length; i++) {
      const x = this.r.next();
      if (x < 0.42) await this.opRecord();
      else if (x < 0.56) await this.opVoid();
      else if (x < 0.64) await this.opReplay();
      else if (x < 0.73) await this.opRecordThenVoid();
      else if (x < 0.86) await this.opAdvance();
      else if (x < 0.92) await this.opExpire();
      else await this.opGrant();
      await this.checkInvariants();
      if (i % 5 === 4) await this.checkPatientCard();
    }
  }
}

test(`ファズ: ${ONLY_SEED ?? SCENARIOS} シナリオ × ${STEPS} 操作で DB とモデルが一致する`, { timeout: 60 * 60 * 1000 }, async () => {
  // PGlite を長時間使い続けると不調になることがあるため、一定数ごとに作り直す
  const BATCH = 50;
  let db = null;
  const seeds = ONLY_SEED != null ? [ONLY_SEED] : Array.from({ length: SCENARIOS }, (_, i) => 1000 + i);
  const findings = [];
  const warnings = new Map();
  let ops = 0;
  for (const [i, seed] of seeds.entries()) {
    if (i % BATCH === 0) {
      await db?.close();
      db = await createDb();
      await db.exec(TODAY_OVERRIDE);
    }
    const sc = new Scenario(db, seed);
    try {
      await sc.run(STEPS);
    } catch (e) {
      sc.finding('exception', `${e.message}`);
    }
    ops += sc.log.length;
    findings.push(...sc.findings);
    for (const w of sc.warnings) {
      const e = warnings.get(w.kind) ?? { count: 0, example: w.detail, seeds: new Set() };
      e.count++;
      e.seeds.add(seed);
      warnings.set(w.kind, e);
    }
  }

  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  console.log(`\n=== ファズ結果: ${seeds.length} シナリオ / ${ops} 操作 ===`);
  console.log(`食い違い: ${findings.length} 件(${byKind.size} 種類)`);
  for (const [kind, list] of byKind) {
    const f = list[0];
    console.log(`\n■ ${kind} — ${list.length} シナリオ(例: seed=${f.seed}, 日付 ${f.today})\n  ${f.detail}`);
    console.log('  直前の操作:');
    for (const l of f.log) console.log('   ', JSON.stringify(l).slice(0, 400));
  }
  console.log(`\n要確認の挙動(仕様の判断が必要):`);
  for (const [kind, w] of warnings) console.log(`  ・${kind}: ${w.count} 回 / ${w.seeds.size} シナリオ(例: ${w.example})`);
  assert.equal(findings.length, 0, `DB とモデルの食い違いが ${findings.length} 件`);
});

