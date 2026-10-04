// 今日の一覧(Notion の「本日カルテ作成」と「未記録リスト」の置き換え)
//  受付した人が「未記録」で並び、施術記録を付けると「完了」になる。初回の問診票を送った人は自動で並ぶ
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Camera, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, CircleSlash, ClipboardList, NotebookPen,
  Search, Sparkles, UserPlus, Undo2, X,
} from 'lucide-react';
import { cancelCheckin, checkin, setCheckinChange, useDay, type DayItem } from '../lib/chart';
import { errorText, useAllMenus, useCustomerSearch } from '../lib/data';
import { BusinessError } from '../lib/rpc';
import { yen } from '../lib/pricing';
import { pickName } from '../i18n';
import { Alert, Avatar, ErrorBox, Loading } from '../ui';

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export default function Today() {
  const { t } = useTranslation();
  const [date, setDate] = useState<string | null>(null);
  const day = useDay(date);
  const [adding, setAdding] = useState(false);

  if (day.isPending) return <Loading />;
  if (day.isError) return <ErrorBox text={errorText(t, day.error)} onRetry={() => void day.refetch()} />;
  const d = day.data;
  const isToday = d.date === d.today;
  const waiting = d.items.filter((i) => i.state === 'waiting').length;
  const done = d.items.filter((i) => i.state === 'done').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isToday ? t('today.title') : d.date}</h1>
          <p>{t('today.subtitle')}</p>
        </div>
        <div className="inline">
          <button type="button" className="btn-sm" onClick={() => setDate(addDays(d.date, -1))} title={t('today.prev')}><ChevronLeft size={16} /></button>
          {!isToday && <button type="button" className="btn-sm" onClick={() => setDate(null)}>{t('today.backToToday')}</button>}
          <button type="button" className="btn-sm" disabled={isToday} onClick={() => setDate(addDays(d.date, 1))} title={t('today.next')}><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="tiles tiles-3">
        <div className="card tile"><div className="tile-head">{t('today.waiting')}</div><div className="tile-value" style={{ color: waiting ? 'var(--danger)' : undefined }}>{waiting}</div></div>
        <div className="card tile"><div className="tile-head">{t('today.done')}</div><div className="tile-value">{done}</div></div>
        <div className="card tile"><div className="tile-head">{t('today.total')}</div><div className="tile-value">{d.items.length}</div></div>
      </div>

      {isToday && (adding
        ? <CheckinSearch onClose={() => setAdding(false)} />
        : <button type="button" className="btn-primary btn-lg" style={{ justifySelf: 'start' }} onClick={() => setAdding(true)}>
            <UserPlus size={18} />{t('today.checkin')}
          </button>)}

      <section className="card fade-in">
        {d.items.length === 0 ? (
          <div className="empty"><ClipboardList size={28} /><span>{isToday ? t('today.empty') : t('today.emptyDay')}</span></div>
        ) : (
          <ul className="list">{d.items.map((i) => <DayRow key={i.checkin_id ?? i.visit?.id} item={i} canEdit={isToday} />)}</ul>
        )}
      </section>
    </>
  );
}

const STATE_BADGE = {
  waiting: { cls: 'badge-danger', Icon: CircleDashed },
  done: { cls: 'badge-accent', Icon: CheckCircle2 },
  no_show: { cls: '', Icon: CircleSlash },
  voided: { cls: 'badge-warn', Icon: Undo2 },
} as const;

function DayRow({ item: i, canEdit }: { item: DayItem; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const menus = useAllMenus();
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { cls, Icon } = STATE_BADGE[i.state];
  const menu = menus.data?.find((m) => m.id === i.visit?.menu_id);
  const time = new Date(i.at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); await qc.invalidateQueries({ queryKey: ['day'] }); } catch (e) { setError(errorText(t, e)); }
  }

  return (
    <li className="day-row">
      <Link to={i.state === 'waiting' ? `/staff/record/${i.customer.id}` : `/staff/customers/${i.customer.id}`} className="list-item">
        <Avatar name={i.customer.name} seed={i.customer.id} />
        <div className="list-main">
          <div className="list-title">{i.customer.name}</div>
          <div className="list-sub inline" style={{ gap: 6 }}>
            <span className="mono">{i.customer.code}</span>
            <span>{time}</span>
            {i.visit?.attended && menu && <span>{pickName(menu.name, i18n.language)} · {yen(i.visit.total)}</span>}
            {i.visit?.unpaid && <span className="badge badge-danger">{t('record.unpaid')}</span>}
            {i.notes > 0 && <span className="inline" style={{ gap: 2 }}><NotebookPen size={13} />{i.notes}</span>}
            {i.photos > 0 && <span className="inline" style={{ gap: 2 }}><Camera size={13} />{i.photos}</span>}
          </div>
        </div>
        <div className="day-badges">
          {i.is_first && <span className="badge badge-info"><Sparkles size={13} />{t('record.firstVisit')}</span>}
          {i.source === 'questionnaire' && <span className="badge">{t('today.fromQuestionnaire')}</span>}
          {i.change_from_last === 'changed' && <span className="badge badge-warn">{t('customer.changed')}</span>}
          <span className={`badge ${cls}`}><Icon size={13} />{t(`today.state_${i.state}`)}</span>
        </div>
      </Link>
      {canEdit && i.state === 'waiting' && i.checkin_id && (
        <div className="day-actions">
          <span className="small muted">{t('record.change')}</span>
          <div className="segmented segmented-sm">
            <button type="button" className={i.change_from_last === 'none' ? 'on' : ''}
                    onClick={() => void run(() => setCheckinChange(i.checkin_id!, i.change_from_last === 'none' ? null : 'none'))}>{t('record.changeNone')}</button>
            <button type="button" className={i.change_from_last === 'changed' ? 'on bad' : ''}
                    onClick={() => void run(() => setCheckinChange(i.checkin_id!, i.change_from_last === 'changed' ? null : 'changed'))}>{t('record.changeYes')}</button>
          </div>
          <span className="spacer" />
          {confirmCancel ? (
            <>
              <button type="button" className="btn-danger btn-sm" onClick={() => void run(() => cancelCheckin(i.checkin_id!))}>{t('today.cancelCheckin')}</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmCancel(false)}><X size={14} /></button>
            </>
          ) : (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmCancel(true)}><X size={14} />{t('today.cancelCheckin')}</button>
          )}
          <Link to={`/staff/record/${i.customer.id}`} className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>{t('record.record')}</Link>
        </div>
      )}
      {error && <div style={{ padding: '0 16px 12px' }}><Alert kind="error">{error}</Alert></div>}
    </li>
  );
}

function CheckinSearch({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const deferred = useDeferredValue(q);
  const hits = useCustomerSearch(deferred, 8);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [secondFor, setSecondFor] = useState<string | null>(null);

  async function pick(id: string, second = false) {
    setBusy(id);
    setError('');
    setSecondFor(null);
    try {
      await checkin(id, second);
      await qc.invalidateQueries({ queryKey: ['day'] });
      onClose();
    } catch (e) {
      if (e instanceof BusinessError && e.code === 'already_recorded_today') setSecondFor(id);
      else setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card card-pad fade-in" style={{ display: 'grid', gap: 12 }}>
      {secondFor && (
        <Alert kind="warn">
          <div style={{ display: 'grid', gap: 8 }}>
            <span>{t('today.alreadyRecorded')}</span>
            <div className="inline">
              <button type="button" className="btn-sm" onClick={() => void pick(secondFor, true)}>{t('today.secondVisit')}</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setSecondFor(null)}>{t('customer.cancel')}</button>
            </div>
          </div>
        </Alert>
      )}
      <div className="inline">
        <h2 style={{ margin: 0 }}>{t('today.checkin')}</h2>
        <span className="spacer" />
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{t('today.checkinHint')}</p>
      <label className="search">
        <Search size={20} />
        <input type="search" autoFocus placeholder={t('patients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      {(hits.data?.length ?? 0) > 0 && (
        <ul className="list card">
          {hits.data!.map((c) => (
            <li key={c.id}>
              <button type="button" className="list-item" disabled={!!busy} onClick={() => void pick(c.id)}>
                <Avatar name={c.name} seed={c.id} />
                <span className="list-main">
                  <span className="list-title">{c.name}</span>
                  <span className="list-sub">{c.furigana ?? '—'}{c.last_visit ? ` · ${t('record.lastVisit', { date: c.last_visit })}` : ''}</span>
                </span>
                <span className="badge mono">{c.code}</span>
                <UserPlus size={18} className="chev" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
