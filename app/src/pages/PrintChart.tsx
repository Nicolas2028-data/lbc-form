// カルテの印刷(A4・白い紙向け)。画面では紙のプレビュー、印刷ボタンでブラウザの印刷を開く
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileSpreadsheet, Printer } from 'lucide-react';
import { exportPatientXlsx, loadPatient, logExport, type PatientBundle } from '../lib/export';
import { useChartImage } from '../lib/chart';
import { errorText, useAllMenus, useSignedImage } from '../lib/data';
import { questionnaireRows } from '../components/QuestionnaireCard';
import { pickName } from '../i18n';
import { yen } from '../lib/pricing';
import { Alert, ErrorBox, Loading } from '../ui';

function Photo({ path }: { path: string }) {
  const url = useChartImage(path);
  return url.data ? <img src={url.data} alt="" /> : <div className="print-photo-empty" />;
}
function QImg({ path }: { path?: string }) {
  const url = useSignedImage(path);
  if (!path || !url.data) return null;
  return <img src={url.data} alt="" className="print-qimg" />;
}

export default function PrintChart() {
  const { customerId } = useParams();
  const { t, i18n } = useTranslation();
  const { t: tq } = useTranslation('q');
  const menus = useAllMenus();
  const data = useQuery({ queryKey: ['print', customerId], queryFn: () => loadPatient(customerId!), staleTime: 0 });
  const [limit, setLimit] = useState<number>(0);   // 0 = すべて
  const [withPhotos, setWithPhotos] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (data.isPending || menus.isPending) return <Loading />;
  if (data.isError) return <ErrorBox text={errorText(t, data.error)} onRetry={() => void data.refetch()} />;
  const p: PatientBundle = data.data;
  const c = p.customer as Record<string, string | string[] | null>;
  const visits = limit ? p.visits.slice(0, limit) : p.visits;
  const general = p.notes.filter((n) => !n.visit_id);
  const q = p.questionnaires[0];
  const creditBalance = p.credits.reduce((s, e) => s + e.amount, 0);
  const menuName = (id: string | null) => (id ? pickName(menus.data?.find((m) => m.id === id)?.name ?? {}, i18n.language) : '—');
  const ctx = { t, tq: tq as (k: string) => string, lang: i18n.language, menus: menus.data ?? [] };

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(errorText(t, e)); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="no-print print-toolbar">
        <Link to={`/staff/customers/${customerId}`} className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}><ArrowLeft size={16} />{t('app.back')}</Link>
        <span className="spacer" />
        <label className="check small">
          <span>{t('export.visitsToPrint')}</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: 'auto', minHeight: 36 }}>
            <option value={0}>{t('export.all')}</option><option value={10}>{t('export.lastN', { count: 10 })}</option><option value={3}>{t('export.lastN', { count: 3 })}</option>
          </select>
        </label>
        <label className="check small"><input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />{t('export.withPhotos')}</label>
        <button type="button" disabled={busy} onClick={() => void run(() => exportPatientXlsx(customerId!, ctx))}><FileSpreadsheet size={16} />Excel</button>
        <button type="button" className="btn-primary" disabled={busy}
                onClick={() => void run(async () => { await logExport('patient_print', customerId!, { visits: visits.length }); window.print(); })}>
          <Printer size={16} />{t('export.print')}
        </button>
      </div>
      {error && <div className="no-print"><Alert kind="error">{error}</Alert></div>}
      <p className="no-print muted small">{t('export.privacyNote')}</p>

      <article className="print-sheet">
        <header className="print-head">
          <div>
            <div className="print-kicker">LBC Care · {t('export.chartTitle')}</div>
            <h1>{c.name as string} <span className="print-code">{c.code as string}</span></h1>
            {c.furigana && <div className="print-sub">{c.furigana as string}</div>}
          </div>
          <div className="print-meta">{t('export.printedAt', { date: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) })}</div>
        </header>

        <section className="print-block">
          <h2>{t('customer.info')}</h2>
          <dl className="print-dl">
            <dt>{t('customer.birth')}</dt><dd>{(c.birth_date as string) ?? '—'}</dd>
            <dt>{t('customer.phone')}</dt><dd>{(c.phone_normalized as string) ?? '—'}</dd>
            <dt>{t('customer.email')}</dt><dd>{(c.email as string) ?? '—'}</dd>
            <dt>{t('customer.address')}</dt><dd>{(c.address as string) ?? '—'}</dd>
            <dt>{t('customer.lang')}</dt><dd>{String(c.lang ?? '').toUpperCase()}</dd>
            <dt>{t('customer.firstVisit')}</dt><dd>{(c.first_visit_date as string) ?? '—'}</dd>
            <dt>{t('customer.visits')}</dt><dd>{p.visits.filter((v) => v.status === 'recorded' && v.attended).length}</dd>
            <dt>{t('customer.credit')}</dt><dd>{yen(creditBalance)}</dd>
          </dl>
          {c.notes && <p className="print-note"><b>{t('customer.notes')}:</b> {c.notes as string}</p>}
        </section>

        {general.length > 0 && (
          <section className="print-block">
            <h2>{t('chart.general')}</h2>
            {general.map((n, i) => <p key={i} className={`print-note ${n.pinned ? 'pinned' : ''}`}>{n.pinned && <b>【{t('export.alert')}】</b>}{n.body}</p>)}
          </section>
        )}

        {q && (
          <section className="print-block">
            <h2>{t('customer.questionnaire')}({q.submitted_at.slice(0, 10)})</h2>
            <dl className="print-dl">
              {questionnaireRows(q, tq as (k: string) => string).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
            <div className="print-qimgs"><QImg path={q.image_paths.body} /><QImg path={q.image_paths.signature} /></div>
          </section>
        )}

        <section className="print-block">
          <h2>{t('chart.title')}({t('export.visitCount', { count: visits.length })})</h2>
          {visits.length === 0 && <p>—</p>}
          {visits.map((v) => {
            const notes = p.notes.filter((n) => n.visit_id === v.id);
            const photos = withPhotos ? p.photos.filter((x) => x.visit_id === v.id) : [];
            const total = v.sales.reduce((s, x) => s + x.amount, 0);
            return (
              <div key={v.id} className={`print-visit ${v.status === 'voided' ? 'voided' : ''}`}>
                <div className="print-visit-head">
                  <b>{v.visit_date}</b>
                  <span>{v.attended ? menuName(v.menu_id) : t('customer.noShow')}</span>
                  {v.change_from_last === 'changed' && <span>【{t('customer.changed')}】</span>}
                  {v.status === 'voided' && <span>【{t('record.voided')}】</span>}
                  <span className="print-amount">{yen(total)}</span>
                </div>
                {(v.memo || v.no_show_reason) && <p className="print-memo">{v.memo || v.no_show_reason}</p>}
                {notes.map((n, i) => <p key={i} className="print-memo">{n.body}</p>)}
                {photos.length > 0 && <div className="print-photos">{photos.map((x) => <Photo key={x.path} path={x.path} />)}</div>}
              </div>
            );
          })}
        </section>
        <footer className="print-foot">{t('export.confidential')}</footer>
      </article>
    </>
  );
}
