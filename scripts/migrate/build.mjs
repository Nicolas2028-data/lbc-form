// 現行の LBC台帳(Google スプレッドシートを .xlsx で書き出したもの)を、新基盤に入れる SQL に変換する。
//
//   node scripts/migrate/build.mjs <LBC台帳.xlsx>
//
// 出力(scripts/migrate/out/ — 個人情報を含むので git 管理外):
//   import.sql    … テスト環境で実行する SQL(1 トランザクション)
//   expected.json … 照合用の「正解」(シートから直接計算した件数・金額。患者番号のみで個人情報なし)
// 画面に出すのは件数・金額・患者番号・行番号だけ(氏名・電話などは出さない)。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import XLSX from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
const STORE = '00000000-0000-4000-8000-000000000001';

// 現行 GAS の列(gas/Code.js の CM / TR / QU / CR)
const CM = { customer_id: 0, name: 1, furigana: 2, phone: 3, email: 4, dob: 5, first_visit: 6, lang: 7, how_found: 8, address: 9, status: 10, created_at: 12, notes: 17 };
const TR = { entry_id: 0, type: 1, target_entry_id: 2, date: 3, customer_id: 4, course: 5, sales: 6, payment: 7, memo: 8, credit_used: 10, referrer_customer_id: 11, count_eligible: 12, created_at: 14 };
const QU = { entry_id: 0, date: 1, customer_id: 2, visit_type: 3, has_changes: 4, main_symptom: 5, duration: 6, pain_level: 7, safety_check: 8, safety_note: 9, goal: 10, strength: 11, disliked: 12, photo_consent: 13, face_pref: 14, consent_agreed: 15, consent_date: 16, body_image_url: 17, sig_url: 18, created_at: 20, raw_json: 23 };
const CR = { entry_id: 0, date: 1, customer_id: 2, type: 3, amount: 4, expiry: 5, rel_entry_id: 6, created_at: 7 };

const COURSE = {
  'カイロプラクティック': 'chiro', '筋膜リリース': 'fascia', '吸い玉・カッピング': 'cupping', '吸い玉（カッピング）': 'cupping',
  '吸い玉(カッピング)': 'cupping', 'カッピング': 'cupping', 'トータルケア': 'total', '月2回コース': 'monthly2_visit', '月2回プラン': 'monthly2_visit',
};
const PAYMENT = { '現金': 'cash', 'カード': 'card', 'PayPay': 'paypay', 'paypay': 'paypay', '未払い': 'unpaid', 'その他': 'other' };

// ── 読み込み ──
const file = process.argv[2];
if (!file) { console.error('使い方: node scripts/migrate/build.mjs <LBC台帳.xlsx>'); process.exit(1); }
const wb = XLSX.read(readFileSync(file), { cellDates: true });
const sheet = (name) => {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).slice(1)
    .map((row, i) => ({ row, line: i + 2 }))
    .filter(({ row }) => row.some((v) => v !== '' && v !== null));
};
const report = { tabs: {}, warnings: {} };
const warn = (kind, detail) => { (report.warnings[kind] ??= []).push(detail); };

const S = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(S(v));
// 日付: Date(日付セル)は年月日をそのまま、文字列は先頭の YYYY-MM-DD
const ymd = (v) => {
  if (v instanceof Date && !isNaN(v)) {
    // SheetJS はタイムゾーンなしの日付を UTC 0 時として返す。日本時間で 0 時台の時刻付きの値にも対応するため +9h して日付を取る
    const t = new Date(v.getTime() + 9 * 3600e3);
    return t.toISOString().slice(0, 10);
  }
  const m = S(v).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const ts = (v) => {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime()).toISOString();
  const s = S(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const bool = (v) => v === true || /^true$/i.test(S(v));
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const qj = (o) => `${q(JSON.stringify(o))}::jsonb`;
const addYear = (d) => { const [y, m, day] = d.split('-').map(Number); const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate(); return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`; };
const eom = (d) => { const t = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0); return t.toISOString().slice(0, 10); };

const cmRows = sheet('顧客マスタ');
const trRows = sheet('施術台帳');
const crRows = sheet('クレジット台帳') ?? [];
const quRows = sheet('問診台帳') ?? [];
if (!cmRows || !trRows) { console.error('「顧客マスタ」「施術台帳」タブが見つかりません。シート名: ' + wb.SheetNames.join(', ')); process.exit(1); }
report.tabs = { 顧客マスタ: cmRows.length, 施術台帳: trRows.length, クレジット台帳: crRows.length, 問診台帳: quRows.length };

// ── 顧客 ──
const customers = new Map();   // code → { id, ... }
for (const { row, line } of cmRows) {
  const code = S(row[CM.customer_id]).toUpperCase();
  if (!code) { warn('顧客: 患者番号なし(スキップ)', `行${line}`); continue; }
  if (customers.has(code)) { warn('顧客: 患者番号の重複(後の行をスキップ)', `${code} 行${line}`); continue; }
  const name = S(row[CM.name]);
  if (!name) warn('顧客: 氏名なし(「(氏名なし)」で登録)', code);
  let lang = S(row[CM.lang]).toLowerCase();
  if (!['ja', 'pt', 'es'].includes(lang)) { if (lang) warn('顧客: 言語が ja/pt/es 以外(ja で登録)', `${code}`); lang = 'ja'; }
  const birth = ymd(row[CM.dob]);
  if (S(row[CM.dob]) && !birth) warn('顧客: 生年月日を読めない(空で登録)', code);
  customers.set(code, {
    id: randomUUID(), code, name: name || '(氏名なし)', furigana: S(row[CM.furigana]) || null,
    phone: S(row[CM.phone]) || null, email: S(row[CM.email]) || null, birth, lang,
    how_found: S(row[CM.how_found]).split(/[,、，]/).map((x) => x.trim()).filter(Boolean),
    address: S(row[CM.address]) || null, notes: S(row[CM.notes]) || null,
    status: S(row[CM.status]) === 'archived' ? 'archived' : 'active',
    created_at: ts(row[CM.created_at]),
  });
}
const cust = (code, ctx) => {
  const c = customers.get(S(code).toUpperCase());
  if (!c && ctx) warn(`${ctx}: 患者番号が顧客マスタに無い`, S(code) || '(空)');
  return c;
};

// ── 施術台帳 ──
const trSorted = [...trRows].sort((a, b) => (ts(a.row[TR.created_at]) ?? '').localeCompare(ts(b.row[TR.created_at]) ?? '') || a.line - b.line);
const visits = new Map();      // TR entry_id → visit
const visitOrder = [];
const sales = [];
const voidRows = [];
for (const { row, line } of trSorted) {
  const type = S(row[TR.type]);
  const entry = S(row[TR.entry_id]) || `line-${line}`;
  if (type === 'void') { voidRows.push({ row, line, entry }); continue; }
  if (type !== 'record' && type !== 'no_show' && type !== 'correction') { warn('施術: 未知の種別(スキップ)', `行${line} ${type || '(空)'}`); continue; }
  const c = cust(row[TR.customer_id], '施術');
  if (!c) continue;
  const date = ymd(row[TR.date]);
  if (!date) { warn('施術: 日付を読めない(スキップ)', `行${line}`); continue; }
  if (visits.has(entry)) { warn('施術: entry_id の重複(後の行をスキップ)', `行${line}`); continue; }
  const attended = type !== 'no_show';
  const courseLabel = S(row[TR.course]);
  let menu = null;
  if (attended) {
    menu = COURSE[courseLabel];
    if (!menu) { warn('施術: コース名を判別できない(「不明(移行)」で登録)', courseLabel || '(空)'); menu = 'legacy_unknown'; }
  }
  const v = {
    id: isUuid(entry) ? entry.toLowerCase() : randomUUID(), entry, line, customer: c, date, attended, menu, courseLabel,
    memo: S(row[TR.memo]) || null, sales: num(row[TR.sales]), payment: S(row[TR.payment]), creditUsed: num(row[TR.credit_used]),
    referrer: S(row[TR.referrer_customer_id]) ? cust(row[TR.referrer_customer_id], '施術(紹介者)') : null,
    countEligible: bool(row[TR.count_eligible]), created_at: ts(row[TR.created_at]), status: 'recorded', voidReason: null, voidedAt: null,
  };
  if (!attended) v.noShowReason = (v.memo ?? '').replace(/^no-show 理由:\s*/, '') || '(理由なし)';
  visits.set(entry, v);
  visitOrder.push(v);
  if (v.sales < 0) warn('施術: 売上がマイナスの記録', `行${line}`);
  if (attended && v.sales !== 0) {
    const method = PAYMENT[v.payment] ?? (v.payment ? (warn('施術: 支払方法を判別できない(other で登録)', v.payment), 'other') : 'other');
    sales.push({ visit: v, amount: v.sales, method, kind: v.sales >= 0 ? 'sale' : 'refund', date, sourceLine: line });
  } else if (attended && v.payment === '未払い') {
    warn('施術: 未払いで売上 0 円の記録(現行は未払いを 0 円で記録していたため、未収金は移行されない)', `${c.code} ${date}`);
  }
}
// 取消(void)
for (const { row, line } of voidRows) {
  const target = visits.get(S(row[TR.target_entry_id]));
  if (!target) { warn('取消: 取消対象の記録が見つからない(売上の打ち消しだけ移行)', `行${line}`); }
  const date = ymd(row[TR.date]);
  if (target) {
    if (target.status === 'voided') warn('取消: 同じ記録への二重取消(2 回目は売上の打ち消しだけ)', `行${line}`);
    target.status = 'voided';
    target.voidReason = (S(row[TR.memo]).replace(/^【取消】/, '') || '取消') + '(移行)';
    target.voidedAt = ts(row[TR.created_at]);
  }
  const amount = num(row[TR.sales]);
  if (amount !== 0) {
    const orig = target ? sales.find((s) => s.visit === target && s.kind === 'sale' && !s.reversed) : null;
    if (orig) orig.reversed = true;
    const c = target?.customer ?? cust(row[TR.customer_id], '取消');
    if (c) sales.push({ visit: target ?? null, customer: c, amount: Math.min(amount, 0), method: orig?.method ?? PAYMENT[S(row[TR.payment])] ?? 'other', kind: 'void', reverses: orig ?? null, date: date ?? target?.date, sourceLine: line });
  }
}
// count_eligible = FALSE なのに取消行がない記録(手作業の修正など)→ 取消済みにする(売上はそのまま)
for (const v of visitOrder) {
  if (v.attended && v.status === 'recorded' && !v.countEligible) {
    warn('施術: 集計対象外(count_eligible=FALSE)だが取消行がない → 来院数に数えない(取消済みとして登録、売上はそのまま)', `${v.customer.code} ${v.date}`);
    v.status = 'voided';
    v.voidReason = '移行: 集計対象外(count_eligible=FALSE)';
  }
}

// ── 月2回プラン → 回数券 ──
const passes = [];
const passUses = [];
for (const v of visitOrder.filter((x) => x.menu === 'monthly2_visit')) {
  if (v.sales > 0) {
    const p = { id: randomUUID(), customer: v.customer, from: v.date, until: eom(v.date), visit: v, uses: [], voided: v.status === 'voided' };
    passes.push(p);
    p.uses.push(v);
    passUses.push({ pass: p, visit: v });
  } else {
    const p = passes.find((x) => x.customer === v.customer && !x.voided && x.from.slice(0, 7) === v.date.slice(0, 7) && x.uses.length < 2);
    if (p) { p.uses.push(v); passUses.push({ pass: p, visit: v }); }
    else warn('月2回プラン: 購入の記録が見つからない 2 回目(回数券なしで来院だけ移行)', `${v.customer.code} ${v.date}`);
  }
}

// ── クレジット台帳 ──
const crSorted = [...crRows].sort((a, b) => (ts(a.row[CR.created_at]) ?? '').localeCompare(ts(b.row[CR.created_at]) ?? '') || a.line - b.line);
const credits = [];
const creditById = new Map();
for (const { row, line } of crSorted) {
  const type = S(row[CR.type]);
  const c = cust(row[CR.customer_id], 'クレジット');
  if (!c) continue;
  const amount = num(row[CR.amount]);
  const date = ymd(row[CR.date]) ?? ymd(row[CR.created_at]);
  const rel = S(row[CR.rel_entry_id]);
  const e = { id: randomUUID(), entry: S(row[CR.entry_id]), customer: c, amount, date, line, rel };
  if (type === 'grant') {
    if (amount <= 0) { warn('クレジット: 付与の金額が 0 以下(スキップ)', `行${line}`); continue; }
    const relVisit = visits.get(rel);
    e.kind = 'grant';
    e.expires = ymd(row[CR.expiry]) ?? addYear(date);
    e.reason = relVisit && relVisit.referrer === c ? 'referral' : 'migration';
    e.visit = relVisit ?? null;
  } else if (type === 'use') {
    if (amount >= 0) { warn('クレジット: 使用の金額が 0 以上(スキップ)', `行${line}`); continue; }
    e.kind = 'use';
    e.visit = visits.get(rel) ?? null;
    if (!e.visit) warn('クレジット: 使用に対応する施術記録が無い', `行${line}`);
  } else if (type === 'expire') {
    e.kind = 'expire';
    e.reverses = creditById.get(rel) ?? null;
    if (!e.reverses) { warn('クレジット: 失効の対象の付与が見つからない(最も古い付与に紐づけ)', `行${line}`); e.reverses = credits.find((x) => x.customer === c && x.kind === 'grant') ?? null; }
    if (!e.reverses) { warn('クレジット: 失効の紐づけ先がない(スキップ)', `行${line}`); continue; }
    if (amount >= 0) { warn('クレジット: 失効の金額が 0 以上(スキップ)', `行${line}`); continue; }
  } else if (type === 'refund' || type === 'void') {
    e.kind = 'void';
    // 現行: 取消時に使用額を払い戻す(rel = 取消した施術の entry_id)
    e.reverses = credits.find((x) => x.kind === 'use' && x.customer === c && x.visit && x.visit.entry === rel && !x.refunded)
      ?? creditById.get(rel) ?? null;
    if (!e.reverses) { warn('クレジット: 払い戻しの対象の使用が見つからない(調整の付与として登録)', `行${line}`); e.kind = 'grant'; e.reason = 'migration'; e.expires = addYear(date); }
    else { e.reverses.refunded = true; if (e.reverses.kind === 'use' && amount !== -e.reverses.amount) warn('クレジット: 払い戻し額が使用額と違う', `行${line}`); }
  } else { warn('クレジット: 未知の種別(スキップ)', `行${line} ${type || '(空)'}`); continue; }
  credits.push(e);
  if (e.entry) creditById.set(e.entry, e);
}

// ── 問診台帳 ──
const questionnaires = [];
for (const { row, line } of quRows) {
  const c = cust(row[QU.customer_id], '問診');
  if (!c) continue;
  let raw = {};
  try { raw = S(row[QU.raw_json]) ? JSON.parse(S(row[QU.raw_json])) : {}; } catch { warn('問診: raw_json を読めない(列の値だけ移行)', `行${line}`); }
  const list = (v) => (Array.isArray(v) ? v : S(v).split(',').map((x) => x.trim()).filter(Boolean));
  const answers = {
    migrated: true,
    visit_type: S(row[QU.visit_type]) || raw.visitType || null,
    has_changes: S(row[QU.has_changes]) || raw.hasChanges || null,
    main_symptom: list(raw.mainSymptom ?? row[QU.main_symptom]),
    main_symptom_other: raw.mainSymptomOther ?? '',
    symptom_duration: S(row[QU.duration]) || raw.symptomDuration || null,
    pain_level: S(row[QU.pain_level]) === '' ? null : num(row[QU.pain_level]),
    safety: list(raw.safetyCheck ?? row[QU.safety_check]),
    safety_note: S(row[QU.safety_note]) || raw.safetyNote || '',
    safety_detail: raw.safetyDetail ?? null,
    treatment_goal: S(row[QU.goal]) || raw.treatmentGoal || null,
    treatment_strength: S(row[QU.strength]) || raw.treatmentStrength || null,
    disliked: list(raw.dislikedTreatment ?? row[QU.disliked]),
    photo_consent: S(row[QU.photo_consent]) || raw.photoConsent || null,
    face_preference: S(row[QU.face_pref]) || raw.facePreference || null,
    consent_agreed: bool(row[QU.consent_agreed]),
    consent_date: ymd(row[QU.consent_date]),
    referrer_name: raw.referrerName ?? '',
    legacy_images: { body: S(row[QU.body_image_url]) || null, signature: S(row[QU.sig_url]) || null },
  };
  questionnaires.push({
    id: randomUUID(), request: isUuid(row[QU.entry_id]) ? S(row[QU.entry_id]).toLowerCase() : randomUUID(), customer: c,
    submitted: ts(row[QU.created_at]) ?? (ymd(row[QU.date]) ? `${ymd(row[QU.date])}T09:00:00+09:00` : null),
    lang: ['ja', 'pt', 'es'].includes(S(raw.lang)) ? S(raw.lang) : c.lang, answers,
  });
}

// 紹介者(顧客の referred_by): 最初の来院の紹介者
for (const v of visitOrder) if (v.referrer && !v.customer.referredBy && v.referrer !== v.customer) v.customer.referredBy = v.referrer;

// ── 照合用の正解(シートから直接) ──
const month = (d) => d.slice(0, 7);
const expected = {
  customers: { total: customers.size, active: [...customers.values()].filter((c) => c.status === 'active').length },
  visits: {
    attended: visitOrder.filter((v) => v.attended && v.status === 'recorded').length,
    no_show: visitOrder.filter((v) => !v.attended).length,
    voided: visitOrder.filter((v) => v.status === 'voided').length,
  },
  visitsByCustomer: {}, salesByMonth: {}, salesTotal: 0, creditByCustomer: {}, passes: passes.length, questionnaires: questionnaires.length,
};
// 来院数: 現行の「集計対象」(record・count_eligible=TRUE・取消されていない)
for (const v of visitOrder) if (v.attended && v.status === 'recorded') expected.visitsByCustomer[v.customer.code] = (expected.visitsByCustomer[v.customer.code] ?? 0) + 1;
// 売上: 施術台帳の売上列の合計(record + void 行)を日付の月ごとに
for (const { row } of trRows) {
  const type = S(row[TR.type]);
  if (!['record', 'correction', 'void'].includes(type)) continue;
  const d = ymd(row[TR.date]);
  if (!d || !cust(row[TR.customer_id])) continue;
  const amt = num(row[TR.sales]);
  expected.salesByMonth[month(d)] = (expected.salesByMonth[month(d)] ?? 0) + amt;
  expected.salesTotal += amt;
}
// クレジット残高: クレジット台帳の金額の合計(現行 computeCreditBalance と同じ)
for (const { row } of crRows) {
  const c = cust(row[CR.customer_id]);
  if (!c) continue;
  expected.creditByCustomer[c.code] = (expected.creditByCustomer[c.code] ?? 0) + num(row[CR.amount]);
}

// ── SQL ──
const L = [];
L.push('-- 生成: scripts/migrate/build.mjs(個人情報を含む。共有・コミットしない)');
L.push('begin;');
L.push(`do $$ begin if exists (select 1 from public.customers) then raise exception 'customers is not empty: run reset first'; end if; end $$;`);
// 移行用のメニュー(非公開)
L.push(`insert into public.menus (store_id, code, name, price, active, sort) values
  ('${STORE}', 'monthly2_visit', '{"ja":"月2回プラン(移行)","pt":"Plano 2x/mês (migrado)","es":"Plan 2 veces/mes (migrado)"}', 0, false, 900),
  ('${STORE}', 'legacy_unknown', '{"ja":"不明(移行)","pt":"Desconhecido (migrado)","es":"Desconocido (migrado)"}', 0, false, 999)
  on conflict (store_id, code) do nothing;`);
for (const c of customers.values()) {
  L.push(`insert into public.customers (id, code, name, furigana, phone_normalized, email, birth_date, lang, how_found, address, notes, status, created_at) values (${q(c.id)}, ${q(c.code)}, ${q(c.name)}, ${q(c.furigana)}, ${q(c.phone)}, ${q(c.email)}, ${c.birth ? q(c.birth) : 'null'}, ${q(c.lang)}, ${q('{' + c.how_found.map((x) => '"' + x.replace(/["\\]/g, '') + '"').join(',') + '}')}, ${q(c.address)}, ${q(c.notes)}, ${q(c.status)}, ${c.created_at ? q(c.created_at) : 'now()'});`);
}
for (const c of customers.values()) if (c.referredBy) L.push(`update public.customers set referred_by = ${q(c.referredBy.id)} where id = ${q(c.id)};`);
const maxCode = Math.max(0, ...[...customers.keys()].map((k) => Number(k.replace(/\D/g, '')) || 0));
L.push(`select setval('public.customer_code_seq', ${Math.max(maxCode, 1)});`);
const menuSql = (code) => `(select id from public.menus where store_id = '${STORE}' and code = ${q(code)})`;
for (const v of visitOrder) {
  L.push(`insert into public.visits (id, store_id, customer_id, visit_date, attended, no_show_reason, menu_id, memo, referrer_id, status, voided_at, void_reason, request_id, created_at) values (${q(v.id)}, '${STORE}', ${q(v.customer.id)}, ${q(v.date)}, ${v.attended}, ${v.attended ? 'null' : q(v.noShowReason)}, ${v.attended ? menuSql(v.menu) : 'null'}, ${q(v.attended ? v.memo : null)}, ${v.referrer ? q(v.referrer.id) : 'null'}, ${q(v.status)}, ${v.status === 'voided' ? (v.voidedAt ? q(v.voidedAt) : 'now()') : 'null'}, ${q(v.voidReason)}, ${q(v.id)}, ${v.created_at ? q(v.created_at) : 'now()'});`);
}
for (const s of sales) s.id = randomUUID();
for (const s of sales) {
  const c = s.visit?.customer ?? s.customer;
  L.push(`insert into public.sales (id, store_id, customer_id, visit_id, kind, amount, method, breakdown, reverses_id, occurred_on) values (${q(s.id)}, '${STORE}', ${q(c.id)}, ${s.visit ? q(s.visit.id) : 'null'}, ${q(s.kind)}, ${s.amount}, ${q(s.method)}, ${qj({ migrated: true, course: s.visit?.courseLabel ?? null })}, ${s.reverses ? q(s.reverses.id) : 'null'}, ${q(s.date)});`);
}
for (const p of passes) {
  L.push(`insert into public.passes (id, store_id, customer_id, product_id, total_uses, valid_from, valid_until, visit_id, status) values (${q(p.id)}, '${STORE}', ${q(p.customer.id)}, (select id from public.products where store_id = '${STORE}' and code = 'monthly2'), 2, ${q(p.from)}, ${q(p.until)}, ${q(p.visit.id)}, ${q(p.voided ? 'voided' : 'active')});`);
}
for (const u of passUses) {
  const uid = randomUUID();
  L.push(`insert into public.pass_uses (id, pass_id, visit_id, delta) values (${q(uid)}, ${q(u.pass.id)}, ${q(u.visit.id)}, -1);`);
  if (u.visit.status === 'voided' && !u.pass.voided) L.push(`insert into public.pass_uses (pass_id, visit_id, delta, reverses_id) values (${q(u.pass.id)}, ${q(u.visit.id)}, 1, ${q(uid)});`);
}
// クレジット: 時系列で入れ、使用はその時点で有効な付与に割り当てる(足りなければ報告用の表に記録)
// 現行では期限切れのクレジットが使われていることがある。その場合は期限を問わず残りのある付与に割り当て、件数を報告する
L.push('create temp table _alloc_fallback (use_id uuid, yen integer) on commit drop;');
L.push('create temp table _alloc_shortfall (use_id uuid, missing integer) on commit drop;');
L.push(`create function pg_temp.alloc_any(p_use uuid) returns void language plpgsql as $f$
declare u public.credit_entries; v_left integer; g record; v_take integer;
begin
  select * into u from public.credit_entries where id = p_use;
  v_left := -u.amount - coalesce((select sum(amount) from public.credit_allocations where use_id = p_use), 0);
  for g in select e.id, private.grant_remaining(e.id) as rem from public.credit_entries e
           where e.customer_id = u.customer_id and e.kind = 'grant' order by e.expires_on, e.created_at, e.id loop
    exit when v_left <= 0;
    continue when g.rem <= 0;
    v_take := least(g.rem, v_left);
    insert into public.credit_allocations (use_id, grant_id, amount) values (p_use, g.id, v_take);
    insert into _alloc_fallback values (p_use, v_take);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then insert into _alloc_shortfall values (p_use, v_left); end if;
end $f$;`);
for (const e of credits) {
  L.push(`insert into public.credit_entries (id, customer_id, store_id, kind, amount, reason, expires_on, visit_id, reverses_id, occurred_on) values (${q(e.id)}, ${q(e.customer.id)}, '${STORE}', ${q(e.kind)}, ${e.amount}, ${q(e.reason ?? (e.kind === 'void' ? '移行: 払い戻し' : null))}, ${e.kind === 'grant' ? q(e.expires) : 'null'}, ${e.visit ? q(e.visit.id) : 'null'}, ${e.reverses ? q(e.reverses.id) : 'null'}, ${q(e.date)});`);
  if (e.kind === 'use') {
    L.push(`do $$ begin perform private.allocate_credit_use(${q(e.id)}); exception when others then perform pg_temp.alloc_any(${q(e.id)}); end $$;`);
  }
}
for (const x of questionnaires) {
  L.push(`insert into public.questionnaires (id, store_id, customer_id, submitted_at, lang, answers, pain_areas, image_paths, phone_normalized, request_id, matched_existing) values (${q(x.id)}, '${STORE}', ${q(x.customer.id)}, ${x.submitted ? q(x.submitted) : 'now()'}, ${q(x.lang)}, ${qj(x.answers)}, ${q('{' + x.answers.main_symptom.map((s) => '"' + String(s).replace(/["\\]/g, '') + '"').join(',') + '}')}, '{}'::jsonb, coalesce((select phone_normalized from public.customers where id = ${q(x.customer.id)}), ''), ${q(x.request)}, false);`);
}
L.push(`create temp table _import_result as select 'IMPORTED'::text as m,
  (select count(distinct use_id) from _alloc_fallback)::int as alloc_fallback_uses, (select coalesce(sum(yen), 0) from _alloc_fallback)::int as alloc_fallback_yen,
  (select count(*) from _alloc_shortfall)::int as alloc_shortfall_uses, (select coalesce(sum(missing), 0) from _alloc_shortfall)::int as alloc_shortfall_yen;`);
L.push('commit;');
L.push('select * from _import_result;');

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'import.sql'), L.join('\n') + '\n');
writeFileSync(join(OUT, 'expected.json'), JSON.stringify(expected, null, 1));

// ── 報告(件数のみ)──
console.log('読み込んだ行数:', report.tabs);
console.log('移行する件数:', {
  顧客: customers.size, 来院: visitOrder.length, 売上行: sales.length, クレジット: credits.length,
  回数券: passes.length, 回数券の使用: passUses.length, 問診: questionnaires.length,
});
console.log('照合用の正解:', { ...expected, visitsByCustomer: `${Object.keys(expected.visitsByCustomer).length} 人分`, creditByCustomer: `${Object.keys(expected.creditByCustomer).length} 人分` });
const kinds = Object.entries(report.warnings);
console.log(kinds.length ? '\n要確認(件数と例。氏名などは表示しない):' : '\n要確認: なし');
for (const [k, list] of kinds) console.log(`  ・${k}: ${list.length} 件(例: ${[...new Set(list)].slice(0, 5).join(' / ')})`);
console.log(`\n出力: ${join(OUT, 'import.sql')}(${L.length} 行)`);
