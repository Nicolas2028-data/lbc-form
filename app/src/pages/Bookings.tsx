// スタッフ: 予約(日ごとの一覧・状態変更・代理予約・営業時間と休みの設定)
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, ClipboardPen, ExternalLink, Plus, Settings2, Trash2,
  UserX, XCircle,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BusinessError, newRequestId } from '../lib/rpc';
import { addDays, callRpc, dayRange, formatDate, STORE_ID, tokyoDate, tokyoTime, useSlots } from '../lib/booking';
import { useCustomers, useMenus, errorText, searchKey } from '../lib/data';
import { pickName } from '../i18n';
import { Alert, Avatar, Card, ErrorBox, Loading } from '../ui';
import { useStaff } from './StaffLayout';

interface BookingRow {
  id: string; period: string; status: 'confirmed' | 'cancelled' | 'completed' | 'no_show'; source: string; note: string | null;
  customer_id: string; customers: { name: string; code: string }; menus: { name: Record<string, string> };
}

// tstzrange の文字列 ["2026-10-03 10:00:00+09","…") から開始・終了を取り出す
function parseRange(r: string): [string, string] {
  const m = r.match(/^[[(]"?([^",]+)"?,"?([^")]+)"?[)\]]$/);
  return m ? [m[1], m[2]] : [r, r];
}

const STATUS_BADGE = { confirmed: 'badge-accent', cancelled: 'badge-danger', completed: 'badge-info', no_show: 'badge-warn' } as const;

export default function Bookings() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [date, setDate] = useState(tokyoDate(new Date()));
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const list = useQuery({
    queryKey: ['bookings', date],
    queryFn: async () => {
      const { data, error } = await supabase.from('bookings')
        .select('id, period, status, source, note, customer_id, customers(name, code), menus(name)')
        .overlaps('period', dayRange(date)).order('period');
      if (error) throw new Error(error.message);
      return data as unknown as BookingRow[];
    },
  });

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['bookings'] });
      await qc.invalidateQueries({ queryKey: ['slots'] });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(t, e) });
    }
  }
  const setStatus = (id: string, status: string) => act(() => callRpc('set_booking_status', { p_booking: id, p_status: status }));
  const cancel = (id: string) => act(() => callRpc('cancel_booking', { p: { booking_id: id } }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('bookings.title')}</h1>
          <p><a className="inline" href="/book" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}><ExternalLink size={14} />{t('bookings.publicLink')}</a></p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setShowNew((v) => !v)}><CalendarPlus size={18} />{t('bookings.new')}</button>
      </div>

      <div className="inline">
        <button type="button" className="btn-sm" onClick={() => setDate(addDays(date, -1))}><ChevronLeft size={16} /></button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} />
        <button type="button" className="btn-sm" onClick={() => setDate(addDays(date, 1))}><ChevronRight size={16} /></button>
        <button type="button" className="btn-sm btn-ghost" onClick={() => setDate(tokyoDate(new Date()))}>{t('bookings.today')}</button>
        <span className="spacer" />
        <span className="badge"><CalendarDays size={13} />{formatDate(date, i18n.language)}</span>
      </div>

      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {showNew && <NewBooking defaultDate={date} onDone={(text) => { setShowNew(false); setMsg({ kind: 'ok', text }); void qc.invalidateQueries({ queryKey: ['bookings'] }); }} />}

      <Card title={formatDate(date, i18n.language)} icon={<CalendarClock size={18} />} pad={false}>
        {list.isPending ? <Loading /> : list.isError ? <div className="card-body"><ErrorBox text={errorText(t, list.error)} onRetry={() => void list.refetch()} /></div>
          : list.data.length === 0 ? <div className="empty">{t('bookings.none')}</div> : (
            <div className="timeline">
              {list.data.map((b) => {
                const [s, e] = parseRange(b.period);
                return (
                  <div key={b.id} className={`timeline-item ${b.status === 'cancelled' ? 'voided' : ''}`} style={{ gridTemplateColumns: '110px 1fr auto' }}>
                    <span className="tl-amount">{tokyoTime(s)}<span className="muted small">–{tokyoTime(e)}</span></span>
                    <div className="inline" style={{ minWidth: 0 }}>
                      <Avatar name={b.customers.name} seed={b.customer_id} />
                      <div style={{ minWidth: 0 }}>
                        <div className="tl-title">{b.customers.name} <span className="badge mono">{b.customers.code}</span></div>
                        <div className="tl-sub">{pickName(b.menus.name, i18n.language)}{b.note ? ` · ${b.note}` : ''}</div>
                      </div>
                      <span className={`badge ${STATUS_BADGE[b.status]}`}>{t(`book.status_${b.status}`)}</span>
                    </div>
                    <div className="inline">
                      {b.status === 'confirmed' && (
                        <>
                          <Link to={`/staff/record/${b.customer_id}`} className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}><ClipboardPen size={14} />{t('bookings.record')}</Link>
                          <button type="button" className="btn-sm" onClick={() => void setStatus(b.id, 'completed')} title={t('bookings.complete')}><Check size={14} /></button>
                          <button type="button" className="btn-sm" onClick={() => void setStatus(b.id, 'no_show')} title={t('bookings.noShow')}><UserX size={14} /></button>
                          <button type="button" className="btn-sm btn-danger" onClick={() => void cancel(b.id)} title={t('bookings.cancel')}><XCircle size={14} /></button>
                        </>
                      )}
                      {(b.status === 'completed' || b.status === 'no_show') && (
                        <button type="button" className="btn-sm btn-ghost" onClick={() => void setStatus(b.id, 'confirmed')}>{t('bookings.reopen')}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </Card>

      <ScheduleSettings />
    </>
  );
}

function NewBooking({ defaultDate, onDone }: { defaultDate: string; onDone: (msg: string) => void }) {
  const { t, i18n } = useTranslation();
  const customers = useCustomers();
  const menus = useMenus();
  const [q, setQ] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [menuId, setMenuId] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [slot, setSlot] = useState('');
  const [error, setError] = useState('');
  const [requestId] = useState(newRequestId);
  const slots = useSlots(menuId || undefined, date, date);
  const hits = useMemo(() => {
    const k = searchKey(q);
    return k ? (customers.data ?? []).filter((c) => [c.name, c.furigana, c.code, c.phone_normalized].some((v) => searchKey(v).includes(k))).slice(0, 6) : [];
  }, [customers.data, q]);
  const customer = customers.data?.find((c) => c.id === customerId);

  async function create() {
    setError('');
    try {
      await callRpc('create_booking', { p: { request_id: requestId, store_id: STORE_ID, menu_id: menuId, start_at: slot, customer_id: customerId } });
      onDone(`${t('bookings.created')}: ${customer?.name} ${formatDate(date, i18n.language)} ${tokyoTime(slot)}`);
    } catch (e) {
      setError(e instanceof BusinessError ? errorText(t, e) : t('book.err_net'));
      void slots.refetch();
    }
  }

  return (
    <Card title={t('bookings.new')} icon={<CalendarPlus size={18} />}>
      <div className="field">
        <span>{t('bookings.patient')}</span>
        {customer ? (
          <div className="choice on"><Avatar name={customer.name} seed={customer.id} /><span className="choice-label">{customer.name}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setCustomerId('')}><XCircle size={14} /></button></div>
        ) : (
          <>
            <input type="search" placeholder={t('patients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.length > 0 && (
              <ul className="list card">
                {hits.map((c) => (
                  <li key={c.id}><button type="button" className="list-item" onClick={() => { setCustomerId(c.id); setQ(''); }}>
                    <Avatar name={c.name} seed={c.id} /><span className="list-main"><span className="list-title">{c.name}</span></span><span className="badge mono">{c.code}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="field">
        <span>{t('bookings.menu')}</span>
        <div className="choice-grid">
          {menus.data?.map((m) => (
            <label key={m.id} className={`choice ${menuId === m.id ? 'on' : ''}`}>
              <input type="radio" name="nb-menu" checked={menuId === m.id} onChange={() => { setMenuId(m.id); setSlot(''); }} />
              <span className="choice-label">{pickName(m.name, i18n.language)}</span><span className="choice-meta">{m.duration_min}′</span>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{t('bookings.date')}</span>
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(''); }} style={{ width: 'auto' }} />
      </div>
      {menuId && (
        <div className="field">
          <span>{t('bookings.time')}</span>
          {slots.isPending ? <Loading /> : (slots.data?.get(date) ?? []).length === 0 ? <p className="muted">{t('book.noSlots')}</p> : (
            <div className="slot-grid">
              {slots.data!.get(date)!.map((s) => (
                <button key={s.start_at} type="button" className={`slot ${slot === s.start_at ? 'on' : ''}`} onClick={() => setSlot(s.start_at)}>{tokyoTime(s.start_at)}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <button type="button" className="btn-primary" disabled={!customerId || !menuId || !slot} onClick={() => void create()}>
        <CalendarPlus size={16} />{t('bookings.create')}
      </button>
    </Card>
  );
}

interface Sched { id: string; staff_id: string; weekday: number; start_time: string; end_time: string }
interface Exc { id: string; staff_id: string; date: string; kind: 'off' | 'extra'; start_time: string | null; end_time: string | null }

function ScheduleSettings() {
  const { t } = useTranslation();
  const me = useStaff();
  const qc = useQueryClient();
  const weekdays = t('bookings.weekdays').split(',');
  const isOwner = me.role === 'owner';
  const [err, setErr] = useState('');
  const staffList = useQuery({
    queryKey: ['staff-list'],
    queryFn: async () => {
      const { data, error } = await supabase.from('staff').select('id, display_name').eq('store_id', me.store_id).eq('active', true);
      if (error) throw new Error(error.message);
      return data as { id: string; display_name: string }[];
    },
  });
  const sched = useQuery({
    queryKey: ['schedules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('staff_schedules').select('id, staff_id, weekday, start_time, end_time').order('weekday').order('start_time');
      if (error) throw new Error(error.message);
      return data as Sched[];
    },
  });
  const exc = useQuery({
    queryKey: ['exceptions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('schedule_exceptions').select('id, staff_id, date, kind, start_time, end_time')
        .gte('date', tokyoDate(new Date())).order('date');
      if (error) throw new Error(error.message);
      return data as Exc[];
    },
  });
  const [ns, setNs] = useState({ staff_id: '', weekday: 1, start_time: '10:00', end_time: '19:00' });
  const [ne, setNe] = useState({ staff_id: '', date: tokyoDate(new Date()), kind: 'off' as 'off' | 'extra', allDay: true, start_time: '10:00', end_time: '12:00' });
  const staffId = (v: string) => v || staffList.data?.[0]?.id || '';
  const staffName = (id: string) => staffList.data?.find((s) => s.id === id)?.display_name ?? '';
  const hm = (x: string | null) => (x ?? '').slice(0, 5);

  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    setErr('');
    const { error } = await p;
    if (error) setErr(error.message);
    await qc.invalidateQueries({ queryKey: ['schedules'] });
    await qc.invalidateQueries({ queryKey: ['exceptions'] });
    await qc.invalidateQueries({ queryKey: ['slots'] });
  }

  return (
    <Card title={t('bookings.schedule')} icon={<Settings2 size={18} />}>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field">
        <span>{t('bookings.weekly')}</span>
        {!isOwner && <p className="muted small">{t('bookings.ownerOnly')}</p>}
        {sched.isPending ? <Loading /> : (
          <div className="sched-list">
            {(sched.data ?? []).map((r) => (
              <div key={r.id} className="sched-row">
                <span className="badge">{weekdays[r.weekday]}</span>
                <span className="mono">{hm(r.start_time)}–{hm(r.end_time)}</span>
                {(staffList.data?.length ?? 0) > 1 && <span className="muted small">{staffName(r.staff_id)}</span>}
                <span className="spacer" />
                {isOwner && <button type="button" className="btn-sm btn-ghost" onClick={() => void run(supabase.from('staff_schedules').delete().eq('id', r.id))}><Trash2 size={14} /></button>}
              </div>
            ))}
            {isOwner && (
              <div className="sched-row add">
                <select value={ns.weekday} onChange={(e) => setNs({ ...ns, weekday: Number(e.target.value) })} style={{ width: 'auto' }}>
                  {weekdays.map((w, i) => <option key={i} value={i}>{w}</option>)}
                </select>
                <input type="time" step={1800} value={ns.start_time} onChange={(e) => setNs({ ...ns, start_time: e.target.value })} style={{ width: 'auto' }} />
                <span>–</span>
                <input type="time" step={1800} value={ns.end_time} onChange={(e) => setNs({ ...ns, end_time: e.target.value })} style={{ width: 'auto' }} />
                <button type="button" className="btn-sm" onClick={() => void run(supabase.from('staff_schedules').insert({ store_id: STORE_ID, staff_id: staffId(ns.staff_id), weekday: ns.weekday, start_time: ns.start_time, end_time: ns.end_time }))}>
                  <Plus size={14} />{t('bookings.add')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="field">
        <span>{t('bookings.exceptions')}</span>
        {exc.isPending ? <Loading /> : (
          <div className="sched-list">
            {(exc.data ?? []).map((r) => (
              <div key={r.id} className="sched-row">
                <span className="mono">{r.date}</span>
                <span className={`badge ${r.kind === 'off' ? 'badge-danger' : 'badge-accent'}`}>{t(`bookings.${r.kind}`)}</span>
                <span className="mono">{r.start_time ? `${hm(r.start_time)}–${hm(r.end_time)}` : t('bookings.allDay')}</span>
                <span className="spacer" />
                <button type="button" className="btn-sm btn-ghost" onClick={() => void run(supabase.from('schedule_exceptions').delete().eq('id', r.id))}><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="sched-row add">
              <input type="date" value={ne.date} onChange={(e) => setNe({ ...ne, date: e.target.value })} style={{ width: 'auto' }} />
              <select value={ne.kind} onChange={(e) => setNe({ ...ne, kind: e.target.value as 'off' | 'extra', allDay: e.target.value === 'off' ? ne.allDay : false })} style={{ width: 'auto' }}>
                <option value="off">{t('bookings.off')}</option><option value="extra">{t('bookings.extra')}</option>
              </select>
              {ne.kind === 'off' && (
                <label className="check"><input type="checkbox" checked={ne.allDay} onChange={(e) => setNe({ ...ne, allDay: e.target.checked })} />{t('bookings.allDay')}</label>
              )}
              {!(ne.kind === 'off' && ne.allDay) && (
                <>
                  <input type="time" step={1800} value={ne.start_time} onChange={(e) => setNe({ ...ne, start_time: e.target.value })} style={{ width: 'auto' }} />
                  <span>–</span>
                  <input type="time" step={1800} value={ne.end_time} onChange={(e) => setNe({ ...ne, end_time: e.target.value })} style={{ width: 'auto' }} />
                </>
              )}
              <button type="button" className="btn-sm" onClick={() => void run(supabase.from('schedule_exceptions').insert({
                store_id: STORE_ID, staff_id: staffId(ne.staff_id), date: ne.date, kind: ne.kind,
                start_time: ne.kind === 'off' && ne.allDay ? null : ne.start_time, end_time: ne.kind === 'off' && ne.allDay ? null : ne.end_time,
              }))}><Plus size={14} />{t('bookings.add')}</button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
