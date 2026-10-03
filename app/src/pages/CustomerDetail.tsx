import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, ClipboardPen, Coins, History, Pencil, Save, UserRound, X } from 'lucide-react';
import {
  useCreditHistory, useCustomer, useMenus, usePatientCard, useVisitHistory, errorText, updateCustomer,
  type CustomerFull, type CustomerPatch,
} from '../lib/data';
import { yen } from '../lib/pricing';
import { pickName } from '../i18n';
import { Alert, Avatar, Card, ErrorBox, Loading } from '../ui';
import { QuestionnaireCard } from '../components/QuestionnaireCard';

export default function CustomerDetail() {
  const { customerId } = useParams();
  const { t } = useTranslation();
  const customer = useCustomer(customerId);
  const card = usePatientCard(customerId);

  if (customer.isPending) return <Loading />;
  if (customer.isError) return <ErrorBox text={errorText(t, customer.error)} onRetry={() => void customer.refetch()} />;
  const c = customer.data;

  return (
    <>
      <Link to="/staff" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start', textDecoration: 'none' }}>
        <ArrowLeft size={16} />{t('app.back')}
      </Link>

      <section className="card fade-in">
        <div className="hero">
          <Avatar name={c.name} seed={c.id} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{c.name}</h1>
            <div className="hero-meta">
              <span className="badge mono">{c.code}</span>
              {c.furigana && <span className="badge">{c.furigana}</span>}
              <span className="badge">{c.lang.toUpperCase()}</span>
              {c.status === 'archived' && <span className="badge badge-warn">{t('customer.archived')}</span>}
            </div>
          </div>
          {c.status === 'active' && (
            <Link to={`/staff/record/${c.id}`} className="btn btn-primary" style={{ textDecoration: 'none' }}>
              <ClipboardPen size={18} />{t('record.record')}
            </Link>
          )}
        </div>
        <div className="stats-row">
          <div><div className="k">{t('customer.visits')}</div><div className="v">{card.data?.visit_count ?? '—'}</div></div>
          <div><div className="k">{t('customer.firstVisit')}</div><div className="v">{c.first_visit_date ?? '—'}</div></div>
          <div><div className="k">{t('customer.credit')}</div><div className="v">{card.data ? yen(card.data.credit_available) : '—'}</div></div>
        </div>
      </section>

      <div className="grid-2">
        <InfoCard customer={c} />
        <CreditCard customerId={c.id} />
      </div>
      <HistoryCard customerId={c.id} />
      <QuestionnaireCard customerId={c.id} />
    </>
  );
}

function InfoCard({ customer: c }: { customer: CustomerFull }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CustomerPatch>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const fields: { key: keyof CustomerPatch; label: string; type?: string }[] = [
    { key: 'name', label: t('customer.name') },
    { key: 'furigana', label: t('customer.furigana') },
    { key: 'phone_normalized', label: t('customer.phone'), type: 'tel' },
    { key: 'email', label: t('customer.email'), type: 'email' },
    { key: 'birth_date', label: t('customer.birth'), type: 'date' },
    { key: 'address', label: t('customer.address') },
  ];

  async function save(patch: CustomerPatch) {
    setBusy(true);
    setMsg(null);
    try {
      await updateCustomer(c.id, patch);
      await qc.invalidateQueries({ queryKey: ['customer', c.id] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      setEditing(false);
      setMsg({ kind: 'ok', text: t('customer.saved') });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const patch: CustomerPatch = {};
    for (const f of [...fields.map((x) => x.key), 'notes', 'lang'] as (keyof CustomerPatch)[]) {
      if (form[f] !== undefined && form[f] !== c[f]) (patch as Record<string, unknown>)[f] = form[f] === '' ? null : form[f];
    }
    if (patch.name === null) { setMsg({ kind: 'error', text: t('record.required') }); return; }
    void save(patch);
  }

  const val = (k: keyof CustomerPatch) => (form[k] ?? c[k] ?? '') as string;

  return (
    <Card title={t('customer.info')} icon={<UserRound size={18} />}
          actions={!editing && <button type="button" className="btn-sm" onClick={() => { setForm({}); setEditing(true); }}><Pencil size={14} />{t('customer.edit')}</button>}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {editing ? (
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          {fields.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <input type={f.type ?? 'text'} value={val(f.key)} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </label>
          ))}
          <label className="field">
            <span>{t('customer.lang')}</span>
            <select value={val('lang')} onChange={(e) => setForm({ ...form, lang: e.target.value })}>
              <option value="ja">日本語</option><option value="pt">Português</option><option value="es">Español</option>
            </select>
          </label>
          <label className="field">
            <span>{t('customer.notes')}</span>
            <textarea value={val('notes')} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="inline">
            <button className="btn-primary" disabled={busy}><Save size={16} />{t('customer.save')}</button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}><X size={16} />{t('customer.cancel')}</button>
          </div>
        </form>
      ) : (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 18px', margin: 0 }}>
          {fields.slice(1).map((f) => (
            <div key={f.key} style={{ display: 'contents' }}>
              <dt className="label">{f.label}</dt>
              <dd style={{ margin: 0 }}>{(c[f.key] as string) || <span className="muted">—</span>}</dd>
            </div>
          ))}
          <dt className="label">{t('customer.notes')}</dt>
          <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.notes || <span className="muted">—</span>}</dd>
        </dl>
      )}
      {!editing && (
        confirmArchive ? (
          <Alert kind="warn">
            <div style={{ display: 'grid', gap: 10 }}>
              <span>{t('customer.archiveConfirm')}</span>
              <div className="inline">
                <button type="button" className="btn-danger btn-sm" disabled={busy}
                        onClick={() => { setConfirmArchive(false); void save({ status: 'archived' }); }}>
                  <Archive size={14} />{t('customer.archive')}
                </button>
                <button type="button" className="btn-sm" onClick={() => setConfirmArchive(false)}>{t('customer.cancel')}</button>
              </div>
            </div>
          </Alert>
        ) : c.status === 'active' ? (
          <button type="button" className="btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setConfirmArchive(true)}>
            <Archive size={14} />{t('customer.archive')}
          </button>
        ) : (
          <button type="button" className="btn-sm" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => void save({ status: 'active' })}>
            <ArchiveRestore size={14} />{t('customer.unarchive')}
          </button>
        )
      )}
    </Card>
  );
}

function CreditCard({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const credits = useCreditHistory(customerId);
  const badge = { grant: 'badge-accent', use: 'badge-info', expire: 'badge-warn', void: 'badge-danger' } as const;
  return (
    <Card title={t('customer.credits')} icon={<Coins size={18} />} pad={false}>
      {credits.isPending ? <Loading /> : credits.isError ? (
        <div className="card-body"><ErrorBox text={errorText(t, credits.error)} onRetry={() => void credits.refetch()} /></div>
      ) : credits.data.length === 0 ? (
        <div className="empty">{t('customer.noCredits')}</div>
      ) : (
        <div className="timeline">
          {credits.data.map((e) => (
            <div key={e.id} className="timeline-item">
              <span className="tl-date">{e.occurred_on}</span>
              <div>
                <span className={`badge ${badge[e.kind]}`}>{t(`customer.kind_${e.kind}`)}</span>{' '}
                {e.kind === 'grant' && e.reason && <span className="muted small">{t(`customer.reason_${e.reason}`, { defaultValue: e.reason })}</span>}
                {e.expires_on && <div className="tl-sub">{t('customer.expires', { date: e.expires_on })}</div>}
              </div>
              <span className="tl-amount" style={{ color: e.amount < 0 ? 'var(--danger)' : 'var(--accent)' }}>
                {e.amount > 0 ? '+' : '−'}{yen(Math.abs(e.amount))}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HistoryCard({ customerId }: { customerId: string }) {
  const { t, i18n } = useTranslation();
  const visits = useVisitHistory(customerId);
  const menus = useMenus();
  return (
    <Card title={t('customer.history')} icon={<History size={18} />} pad={false}>
      {visits.isPending ? <Loading /> : visits.isError ? (
        <div className="card-body"><ErrorBox text={errorText(t, visits.error)} onRetry={() => void visits.refetch()} /></div>
      ) : visits.data.length === 0 ? (
        <div className="empty">{t('customer.noHistory')}</div>
      ) : (
        <div className="timeline">
          {visits.data.map((v) => {
            const m = menus.data?.find((x) => x.id === v.menu_id);
            const net = v.sales.reduce((s, x) => s + x.amount, 0);
            const unpaid = v.sales.some((x) => x.method === 'unpaid' && x.kind === 'sale');
            return (
              <div key={v.id} className={`timeline-item ${v.status === 'voided' ? 'voided' : ''}`}>
                <span className="tl-date">{v.visit_date}</span>
                <div>
                  <div className="inline">
                    <span className="tl-title">{v.attended ? (m ? pickName(m.name, i18n.language) : '—') : t('customer.noShow')}</span>
                    {v.change_from_last === 'changed' && <span className="badge badge-warn">{t('customer.changed')}</span>}
                    {v.change_from_last === 'none' && <span className="badge">{t('customer.unchanged')}</span>}
                    {unpaid && <span className="badge badge-danger">{t('record.unpaid')}</span>}
                    {v.status === 'voided' && <span className="badge badge-danger">{t('record.voided')}</span>}
                  </div>
                  {(v.memo || v.no_show_reason) && <div className="tl-sub">{v.memo || v.no_show_reason}</div>}
                  {v.status === 'voided' && v.void_reason && <div className="tl-sub">{t('customer.voidedBecause', { reason: v.void_reason })}</div>}
                </div>
                <span className="tl-amount">{yen(net)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
