// 印刷・Excel 出力。出す前に必ず log_export で記録する(誰がいつ何を出したか)。
// Excel の部品(SheetJS)は重いので、出力するときだけ読み込む
import type { TFunction } from 'i18next';
import { supabase } from './supabase';
import { BusinessError } from './rpc';
import { pickName } from '../i18n';
import { questionnaireRows } from '../components/QuestionnaireCard';
import type { Menu, QuestionnaireRow } from './data';

type Row = Record<string, string | number | null>;

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error.code === 'P0001' ? new BusinessError(error.message) : new Error(error.message);
  return data as T;
}

export const logExport = (kind: 'patient_print' | 'patient_xlsx' | 'customers_xlsx' | 'charts_xlsx', customerId: string | null = null, detail: Record<string, unknown> = {}) =>
  must(supabase.rpc('log_export', { p_kind: kind, p_customer: customerId, p_detail: detail }));

/** 1,000 行ずつ全部読む(API は 1 回 1,000 行まで) */
async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(make(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function save(sheets: { name: string; rows: Row[]; widths?: number[] }[], filename: string) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const ws = XLSX.utils.json_to_sheet(sh.rows.length ? sh.rows : [{ '': '' }]);
    const keys = Object.keys(sh.rows[0] ?? {});
    ws['!cols'] = keys.map((k, i) => ({ wch: sh.widths?.[i] ?? Math.min(Math.max(k.length * 2 + 2, ...sh.rows.slice(0, 200).map((r) => String(r[k] ?? '').length + 2), 8), 60) }));
    if (keys.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sh.rows.length, c: keys.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename, { compression: true });
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const yen = (n: number) => n;   // Excel では数値のまま(合計を計算できるように)

interface Ctx { t: TFunction; tq: (k: string) => string; lang: string; menus: Menu[] }
const menuName = (c: Ctx, id: string | null) => (id ? pickName(c.menus.find((m) => m.id === id)?.name ?? {}, c.lang) || '—' : '—');
const payLabel = (c: Ctx, m: string) => c.t(`record.${m}`, { defaultValue: m });

// ── 患者 1 人分 ──
export interface PatientBundle {
  customer: Record<string, unknown> & { id: string; code: string; name: string };
  visits: { id: string; visit_date: string; attended: boolean; status: string; memo: string | null; no_show_reason: string | null;
            change_from_last: string | null; menu_id: string | null; void_reason: string | null; sales: { amount: number; method: string; kind: string }[] }[];
  notes: { visit_id: string | null; body: string; pinned: boolean; created_at: string }[];
  photos: { visit_id: string | null; path: string; caption: string | null; created_at: string }[];
  credits: { kind: string; amount: number; reason: string | null; expires_on: string | null; occurred_on: string }[];
  questionnaires: QuestionnaireRow[];
}

export async function loadPatient(customerId: string): Promise<PatientBundle> {
  const [customer, visits, notes, photos, credits, questionnaires] = await Promise.all([
    must(supabase.from('customers')
      .select('id, code, name, furigana, phone_normalized, email, birth_date, lang, address, how_found, first_visit_date, status, notes, created_at')
      .eq('id', customerId).single()),
    fetchAll((a, b) => supabase.from('visits')
      .select('id, visit_date, attended, status, memo, no_show_reason, change_from_last, menu_id, void_reason, sales(amount, method, kind)')
      .eq('customer_id', customerId).order('visit_date', { ascending: false }).order('created_at', { ascending: false }).range(a, b)),
    fetchAll((a, b) => supabase.from('chart_notes').select('visit_id, body, pinned, created_at')
      .eq('customer_id', customerId).is('deleted_at', null).order('created_at').range(a, b)),
    fetchAll((a, b) => supabase.from('chart_photos').select('visit_id, path, caption, created_at')
      .eq('customer_id', customerId).is('deleted_at', null).order('created_at').range(a, b)),
    fetchAll((a, b) => supabase.from('credit_entries').select('kind, amount, reason, expires_on, occurred_on')
      .eq('customer_id', customerId).order('occurred_on').order('created_at').range(a, b)),
    must(supabase.from('questionnaires').select('id, submitted_at, lang, answers, image_paths, matched_existing')
      .eq('customer_id', customerId).order('submitted_at', { ascending: false }).limit(20)),
  ]);
  return {
    customer: customer as unknown as PatientBundle['customer'], visits: visits as PatientBundle['visits'],
    notes: notes as PatientBundle['notes'], photos: photos as PatientBundle['photos'],
    credits: credits as PatientBundle['credits'], questionnaires: questionnaires as QuestionnaireRow[],
  };
}

export async function exportPatientXlsx(customerId: string, c: Ctx) {
  await logExport('patient_xlsx', customerId);
  const p = await loadPatient(customerId);
  const cu = p.customer as Record<string, string | string[] | null>;
  const t = c.t;
  const info: Row[] = [
    [t('patients.code', { defaultValue: '診察番号' }), cu.code],
    [t('customer.name'), cu.name], [t('customer.furigana'), cu.furigana], [t('customer.phone'), cu.phone_normalized],
    [t('customer.email'), cu.email], [t('customer.birth'), cu.birth_date], [t('customer.lang'), cu.lang],
    [t('customer.address'), cu.address], [t('export.howFound'), Array.isArray(cu.how_found) ? cu.how_found.join('、') : cu.how_found],
    [t('customer.firstVisit'), cu.first_visit_date], [t('customer.notes'), cu.notes],
    [t('chart.general'), p.notes.filter((n) => !n.visit_id).map((n) => (n.pinned ? '【注意】' : '') + n.body).join('\n\n')],
  ].map(([k, v]) => ({ [t('export.item')]: k as string, [t('export.value')]: (v as string) ?? '' }));
  const visits: Row[] = p.visits.map((v) => ({
    [t('export.date')]: v.visit_date,
    [t('record.menu')]: v.attended ? menuName(c, v.menu_id) : t('customer.noShow'),
    [t('export.status')]: v.status === 'voided' ? t('record.voided') : v.attended ? t('today.state_done') : t('today.state_no_show'),
    [t('record.change')]: v.change_from_last === 'changed' ? t('customer.changed') : v.change_from_last === 'none' ? t('customer.unchanged') : '',
    [t('export.amount')]: yen(v.sales.reduce((s, x) => s + x.amount, 0)),
    [t('record.payment')]: [...new Set(v.sales.filter((x) => x.kind === 'sale').map((x) => payLabel(c, x.method)))].join('・'),
    [t('record.memo')]: v.memo || v.no_show_reason || '',
    [t('chart.title')]: p.notes.filter((n) => n.visit_id === v.id).map((n) => n.body).join('\n\n'),
    [t('export.photos')]: p.photos.filter((x) => x.visit_id === v.id).length,
    [t('export.voidReason')]: v.void_reason ?? '',
  }));
  const credits: Row[] = p.credits.map((e) => ({
    [t('export.date')]: e.occurred_on, [t('export.kind')]: t(`customer.kind_${e.kind}`), [t('export.amount')]: e.amount,
    [t('export.reason')]: e.reason ?? '', [t('export.expires')]: e.expires_on ?? '',
  }));
  const qs: Row[] = p.questionnaires.flatMap((q) => questionnaireRows(q, c.tq).map(([k, v]) => ({
    [t('export.date')]: q.submitted_at.slice(0, 10), [t('export.item')]: k, [t('export.value')]: v,
  })));
  await save([
    { name: t('customer.info'), rows: info, widths: [20, 70] },
    { name: t('chart.title'), rows: visits },
    { name: t('customer.credits'), rows: credits },
    { name: t('customer.questionnaire'), rows: qs, widths: [12, 22, 70] },
  ], `LBC_${cu.code}_${today()}.xlsx`);
}

// ── 全員分(オーナーのみ)──
export async function exportCustomersXlsx(c: Ctx) {
  await logExport('customers_xlsx');
  const t = c.t;
  const [customers, visits] = await Promise.all([
    fetchAll((a, b) => supabase.from('customers')
      .select('id, code, name, furigana, phone_normalized, email, birth_date, lang, address, how_found, first_visit_date, status, notes')
      .order('code').range(a, b)),
    fetchAll((a, b) => supabase.from('visits').select('customer_id, visit_date, attended, status').eq('status', 'recorded').range(a, b)),
  ]);
  const agg = new Map<string, { n: number; last: string }>();
  for (const v of visits as { customer_id: string; visit_date: string; attended: boolean }[]) {
    if (!v.attended) continue;
    const x = agg.get(v.customer_id) ?? { n: 0, last: '' };
    x.n++;
    if (v.visit_date > x.last) x.last = v.visit_date;
    agg.set(v.customer_id, x);
  }
  const rows: Row[] = (customers as (Record<string, string | null> & { how_found: string[] | null })[]).map((cu): Row => ({
    [t('patients.code', { defaultValue: '診察番号' })]: cu.code, [t('customer.name')]: cu.name, [t('customer.furigana')]: cu.furigana,
    [t('customer.phone')]: cu.phone_normalized, [t('customer.email')]: cu.email, [t('customer.birth')]: cu.birth_date,
    [t('customer.lang')]: cu.lang, [t('customer.address')]: cu.address,
    [t('export.howFound')]: (cu.how_found ?? []).join('、'),
    [t('customer.firstVisit')]: cu.first_visit_date, [t('customer.visits')]: agg.get(cu.id as string)?.n ?? 0,
    [t('export.lastVisit')]: agg.get(cu.id as string)?.last ?? '',
    [t('export.status')]: cu.status === 'archived' ? t('customer.archived') : '', [t('customer.notes')]: cu.notes,
  }));
  await save([{ name: t('export.customersSheet'), rows }], `LBC_顧客一覧_${today()}.xlsx`);
  return rows.length;
}

export async function exportChartsXlsx(from: string, to: string, c: Ctx) {
  await logExport('charts_xlsx', null, { from, to });
  const t = c.t;
  const visits = await fetchAll((a, b) => supabase.from('visits')
    .select('id, visit_date, attended, status, memo, no_show_reason, change_from_last, menu_id, void_reason, customers!visits_customer_id_fkey(code, name), sales(amount, method, kind)')
    .gte('visit_date', from).lte('visit_date', to).order('visit_date').order('created_at').range(a, b));
  const ids = (visits as { id: string }[]).map((v) => v.id);
  const notes: { visit_id: string; body: string }[] = [];
  const photos = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    notes.push(...(await must(supabase.from('chart_notes').select('visit_id, body').in('visit_id', chunk).is('deleted_at', null).order('created_at'))) as { visit_id: string; body: string }[]);
    for (const ph of (await must(supabase.from('chart_photos').select('visit_id').in('visit_id', chunk).is('deleted_at', null))) as { visit_id: string }[]) {
      photos.set(ph.visit_id, (photos.get(ph.visit_id) ?? 0) + 1);
    }
  }
  type V = PatientBundle['visits'][number] & { customers: { code: string; name: string } | null };
  const rows: Row[] = (visits as unknown as V[]).map((v) => ({
    [t('export.date')]: v.visit_date, [t('patients.code', { defaultValue: '診察番号' })]: v.customers?.code ?? '', [t('customer.name')]: v.customers?.name ?? '',
    [t('record.menu')]: v.attended ? menuName(c, v.menu_id) : t('customer.noShow'),
    [t('export.status')]: v.status === 'voided' ? t('record.voided') : v.attended ? t('today.state_done') : t('today.state_no_show'),
    [t('record.change')]: v.change_from_last === 'changed' ? t('customer.changed') : v.change_from_last === 'none' ? t('customer.unchanged') : '',
    [t('export.amount')]: yen(v.sales.reduce((s, x) => s + x.amount, 0)),
    [t('record.payment')]: [...new Set(v.sales.filter((x) => x.kind === 'sale').map((x) => payLabel(c, x.method)))].join('・'),
    [t('record.memo')]: v.memo || v.no_show_reason || '',
    [t('chart.title')]: notes.filter((n) => n.visit_id === v.id).map((n) => n.body).join('\n\n'),
    [t('export.photos')]: photos.get(v.id) ?? 0,
  }));
  await save([{ name: t('charts.title'), rows }], `LBC_カルテ一覧_${from}_${to}.xlsx`);
  return rows.length;
}
