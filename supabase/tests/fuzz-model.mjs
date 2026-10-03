// ファズテスト用の「本来こうなるべき」モデル。DB の実装とは独立に、業務ルールを素直に書く。
// DB と結果が食い違えば、どちらか(たいてい DB)にロジックの問題がある。

export const REFERRAL_AMOUNT = 1000;
export const REFERRAL_LIMIT = 3;
const METHODS = ['cash', 'card', 'paypay', 'unpaid', 'other'];

// ── 日付(YYYY-MM-DD 文字列・UTC で計算)──
export function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function endOfMonth(d) {
  const t = new Date(`${d.slice(0, 7)}-01T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + 1);
  t.setUTCDate(0);
  return t.toISOString().slice(0, 10);
}
export function addYear(d) {
  const [y, m, day] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
// Postgres の round(numeric) と同じ(0.5 は 0 から遠い方へ)
export const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));

export class ModelError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ModelError(code); };

export class Model {
  constructor() {
    this.customers = new Map();   // id → { id, referredBy }
    this.menus = new Map();       // id → { price }
    this.products = new Map();    // id → { price, uses, validity, validDays }
    this.visits = new Map();      // id → visit
    this.credit = [];             // { customer, kind, amount, expires, reverses, visit, reason, seq }
    this.passes = new Map();      // id → { id, customer, total, validFrom, validUntil, status, boughtVisit }
    this.passUses = [];           // { pass, visit, delta, reverses }
    this.sales = [];              // { visit, amount, method, kind, date, reverses }
    this.requests = new Map();    // request_id → 前回の結果
    this.seq = 0;
  }

  visitsOf(c) { return [...this.visits.values()].filter((v) => v.customer === c); }
  isReversed(entry, kind) { return this.credit.some((x) => x.reverses === entry && x.kind === kind); }

  // ── クレジット(有効期限の近い順に消費)──
  lots(c) {
    let consumed = -this.credit
      .filter((e) => e.customer === c && (e.kind === 'use' || (e.kind === 'void' && e.reverses?.kind === 'use')))
      .reduce((s, e) => s + e.amount, 0);
    const grants = this.credit.filter((g) => g.customer === c && g.kind === 'grant')
      .sort((a, b) => (a.expires < b.expires ? -1 : a.expires > b.expires ? 1 : a.seq - b.seq));
    const out = [];
    for (const g of grants) {
      const lot = g.amount + this.credit
        .filter((x) => x.reverses === g && (x.kind === 'expire' || x.kind === 'void'))
        .reduce((s, x) => s + x.amount, 0);
      const take = Math.min(Math.max(lot, 0), Math.max(consumed, 0));
      consumed -= take;
      out.push({ grant: g, expires: g.expires, remaining: Math.max(lot, 0) - take });
    }
    return { lots: out, unassigned: Math.max(consumed, 0) };
  }
  available(c, asOf) {
    const { lots, unassigned } = this.lots(c);
    return Math.max(lots.filter((l) => l.expires >= asOf).reduce((s, l) => s + l.remaining, 0) - unassigned, 0);
  }
  balance(c) { return this.credit.filter((e) => e.customer === c).reduce((s, e) => s + e.amount, 0); }

  passRemaining(p) {
    return p.total + this.passUses.filter((u) => u.pass === p).reduce((s, u) => s + u.delta, 0);
  }
  referralGrants(ref) {
    return this.credit.filter((g) => g.customer === ref && g.kind === 'grant' && g.reason === 'referral'
      && !this.isReversed(g, 'void')).length;
  }

  // ── 施術記録: 予測(状態は変えない)──
  predictRecord(p, today) {
    if (this.requests.has(p.request_id)) return { duplicate: this.requests.get(p.request_id) };
    const c = p.customer_id;
    if (!this.customers.has(c)) fail('customer_not_found');
    if (!p.allow_same_day && this.visitsOf(c).some((v) => v.date === today && v.status === 'recorded')) {
      fail('already_recorded_today');
    }
    if (!p.attended) {
      if (!p.no_show_reason?.trim()) fail('no_show_reason_required');
      return { attended: false, total: 0 };
    }
    const menu = this.menus.get(p.menu_id);
    if (!menu) fail('menu_invalid');
    if (p.use_pass_id && p.purchase_product_id && p.use_purchased_pass) fail('pass_conflict');
    let covered = false;
    let usePass = null;
    if (p.use_pass_id) {
      usePass = this.passes.get(p.use_pass_id);
      if (!usePass || usePass.customer !== c || usePass.status !== 'active'
          || today < usePass.validFrom || today > usePass.validUntil) fail('pass_invalid');
      if (this.passRemaining(usePass) <= 0) fail('pass_used_up');
      covered = true;
    }
    let product = null;
    if (p.purchase_product_id) {
      product = this.products.get(p.purchase_product_id);
      if (!product) fail('product_invalid');
      if (p.use_purchased_pass) covered = true;
    }
    const menuCharge = covered ? 0 : menu.price;
    const productCharge = product?.price ?? 0;
    const credit = p.credit_use ?? 0;
    let discount = 0;
    if (p.referrer_id) {
      if (p.referrer_id === c || !this.customers.has(p.referrer_id)) fail('referrer_invalid');
      if (this.visitsOf(c).some((v) => v.attended && v.status === 'recorded')) fail('referral_not_first_visit');
      if (credit > 0) fail('referral_and_credit');
      discount = REFERRAL_AMOUNT;
    }
    const subtotal = Math.max(menuCharge + productCharge - discount, 0);
    if (credit < 0) fail('credit_invalid');
    if (credit > 0) {
      const avail = this.available(c, today);
      if (credit > avail) fail(`insufficient_credit:${avail}`);
      if (credit > subtotal) fail('credit_exceeds_amount');
    }
    const total = subtotal - credit;
    if (total > 0 && !METHODS.includes(p.payment_method)) fail('payment_method_required');
    const limitReached = !!p.referrer_id && this.referralGrants(p.referrer_id) >= REFERRAL_LIMIT;
    return { attended: true, total, credit, menuCharge, productCharge, discount, usePass, product, limitReached };
  }

  // ── 施術記録: 反映(DB が成功した後、DB の ID を使って)──
  applyRecord(p, plan, res, today) {
    const c = p.customer_id;
    const visit = {
      id: res.visit_id, customer: c, date: today, attended: plan.attended, status: 'recorded', total: plan.total,
    };
    this.visits.set(visit.id, visit);
    if (plan.attended) {
      if (plan.total > 0) {
        this.sales.push({ visit, amount: plan.total, method: p.payment_method, kind: 'sale', date: today });
      }
      if (plan.credit > 0) {
        this.credit.push({ customer: c, kind: 'use', amount: -plan.credit, visit, seq: ++this.seq });
      }
      if (plan.product) {
        const pass = {
          id: res.pass_id, customer: c, total: plan.product.uses, validFrom: today, status: 'active', boughtVisit: visit,
          validUntil: plan.product.validity === 'end_of_month' ? endOfMonth(today) : addDays(today, plan.product.validDays - 1),
        };
        this.passes.set(pass.id, pass);
        if (p.use_purchased_pass) this.passUses.push({ pass, visit, delta: -1 });
      }
      if (plan.usePass) this.passUses.push({ pass: plan.usePass, visit, delta: -1 });
      if (p.referrer_id) {
        const cust = this.customers.get(c);
        cust.referredBy ??= p.referrer_id;
        if (!plan.limitReached) {
          this.credit.push({
            customer: p.referrer_id, kind: 'grant', amount: REFERRAL_AMOUNT, reason: 'referral',
            expires: addYear(today), visit, seq: ++this.seq,
          });
        }
      }
    }
    this.requests.set(p.request_id, { visit_id: res.visit_id, total: plan.total });
    return visit;
  }

  // ── 取消 ──
  predictVoid(p, today, isOwner) {
    if (this.requests.has(p.request_id)) return { duplicate: this.requests.get(p.request_id) };
    if (!p.reason?.trim()) fail('void_reason_required');
    const v = this.visits.get(p.visit_id);
    if (!v) fail('visit_not_found');
    if (v.status !== 'recorded') fail('already_voided');
    if (v.date !== today && !isOwner) fail('void_past_requires_owner');
    for (const ps of this.passes.values()) {
      if (ps.boughtVisit !== v || ps.status !== 'active') continue;
      const usedElsewhere = this.passUses.some((u) => u.pass === ps && u.visit !== v && u.delta === -1
        && !this.passUses.some((x) => x.reverses === u));
      if (usedElsewhere) fail('pass_in_use');
    }
    return { visit: v };
  }

  applyVoid(p, plan, today) {
    const v = plan.visit;
    v.status = 'voided';
    for (const s of this.sales.filter((x) => x.visit === v && x.kind === 'sale' && !this.sales.some((y) => y.reverses === x))) {
      this.sales.push({ visit: v, amount: -s.amount, method: s.method, kind: 'void', date: today, reverses: s });
    }
    for (const e of this.credit.filter((x) => x.visit === v && (x.kind === 'use' || x.kind === 'grant') && !this.isReversed(x, 'void'))) {
      this.credit.push({ customer: e.customer, kind: 'void', amount: -e.amount, reverses: e, visit: v, seq: ++this.seq });
    }
    for (const u of this.passUses.filter((x) => x.visit === v && x.delta === -1 && !this.passUses.some((y) => y.reverses === x))) {
      this.passUses.push({ pass: u.pass, visit: v, delta: 1, reverses: u });
    }
    for (const ps of this.passes.values()) if (ps.boughtVisit === v && ps.status === 'active') ps.status = 'voided';
    this.requests.set(p.request_id, { visit_id: v.id, voided: true });
  }

  // ── 失効 ──
  applyExpire(asOf) {
    for (const c of this.customers.keys()) {
      for (const l of this.lots(c).lots) {
        if (l.expires < asOf && l.remaining > 0) {
          this.credit.push({ customer: c, kind: 'expire', amount: -l.remaining, reverses: l.grant, seq: ++this.seq });
        }
      }
    }
  }

  manualGrant(c, amount, expires) {
    this.credit.push({ customer: c, kind: 'grant', amount, reason: 'manual', expires, seq: ++this.seq });
  }

  // ── 期待される集計 ──
  // 新規 = その月に「最初の(取消されていない)来院」があった患者
  expectedStats() {
    const months = new Map();
    const m = (d) => {
      const k = `${d.slice(0, 7)}-01`;
      if (!months.has(k)) months.set(k, { visits: 0, newCustomers: 0, sales: 0, unpaid: 0 });
      return months.get(k);
    };
    const first = new Map();
    for (const v of this.visits.values()) {
      if (!v.attended || v.status !== 'recorded') continue;
      m(v.date).visits++;
      if (!first.has(v.customer) || v.date < first.get(v.customer)) first.set(v.customer, v.date);
    }
    for (const d of first.values()) m(d).newCustomers++;
    for (const s of this.sales) {
      const row = m(s.date);
      if (s.method === 'unpaid') row.unpaid += s.amount; else row.sales += s.amount;
    }
    for (const v of this.visits.values()) m(v.date);
    const out = {};
    for (const [k, r] of months) {
      out[k] = { ...r, avg: r.visits > 0 ? roundHalfAway(r.sales / r.visits) : null };
    }
    return out;
  }
}
