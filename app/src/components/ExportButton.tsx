// 全員分の Excel 出力ボタン(オーナーだけに表示。サーバー側でもオーナー以外は記録段階で拒否)
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, Loader2 } from 'lucide-react';
import { exportChartsXlsx, exportCustomersXlsx, exportTaxXlsx } from '../lib/export';
import { errorText, useAllMenus } from '../lib/data';
import { useStaff } from '../pages/StaffLayout';
import { Alert } from '../ui';

export function ExportButton({ kind, from, to }: { kind: 'customers' | 'charts'; from?: string; to?: string }) {
  const { t, i18n } = useTranslation();
  const { t: tq } = useTranslation('q');
  const staff = useStaff();
  const menus = useAllMenus();
  const [state, setState] = useState<'idle' | 'busy' | 'confirm'>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (staff.role !== 'owner') return null;

  async function run() {
    setState('busy');
    setMsg(null);
    const ctx = { t, tq: tq as (k: string) => string, lang: i18n.language, menus: menus.data ?? [] };
    try {
      const n = kind === 'customers' ? await exportCustomersXlsx(ctx) : await exportChartsXlsx(from!, to!, ctx);
      setMsg({ kind: 'ok', text: t('export.done', { count: n }) });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(t, e) });
    } finally {
      setState('idle');
    }
  }

  return (
    <span className="inline" style={{ gap: 6 }}>
      {state === 'confirm' ? (
        <>
          <span className="small">{t('export.confirmBulk')}</span>
          <button type="button" className="btn-sm btn-primary" onClick={() => void run()}>{t('export.download')}</button>
          <button type="button" className="btn-sm btn-ghost" onClick={() => setState('idle')}>{t('customer.cancel')}</button>
        </>
      ) : (
        <button type="button" className="btn-sm" disabled={state === 'busy'} onClick={() => setState('confirm')}>
          {state === 'busy' ? <Loader2 size={14} className="spin" /> : <FileSpreadsheet size={14} />}
          {kind === 'customers' ? t('export.customersXlsx') : t('export.chartsXlsx')}
        </button>
      )}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
    </span>
  );
}

export function TaxExportButton() {
  const { t, i18n } = useTranslation();
  const staff = useStaff();
  const menus = useAllMenus();
  const curYear = new Date().getFullYear();
  const years = Array.from({ length: curYear - 2025 }, (_, i) => String(2026 + i));
  const [year, setYear] = useState(String(curYear));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (staff.role !== 'owner') return null;

  async function run() {
    setBusy(true);
    setMsg(null);
    const ctx = { t, tq: () => '', lang: i18n.language, menus: menus.data ?? [] };
    try {
      await exportTaxXlsx(year, ctx);
      setMsg({ kind: 'ok', text: t('export.done', { count: year }) });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
      <label className="small muted">{t('export.taxYear')}</label>
      <select value={year} onChange={(e) => setYear(e.target.value)} className="select-sm">
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 size={14} className="spin" /> : <FileSpreadsheet size={14} />}
        {t('export.taxXlsx')}
      </button>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
    </span>
  );
}
