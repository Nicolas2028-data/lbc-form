// お客様の予約ページ(ログイン不要、ja/pt/es)
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Check, CheckCircle2, Clock, Copy, Leaf, Send, Stethoscope, UserRound } from 'lucide-react';
import { useMenus } from '../lib/data';
import { BusinessError, newRequestId } from '../lib/rpc';
import { addDays, callRpc, formatDate, STORE_ID, tokyoDate, tokyoTime, useSlots } from '../lib/booking';
import { yen } from '../lib/pricing';
import { pickName } from '../i18n';
import { Alert, Loading } from '../ui';
import { LangSwitch } from './StaffLayout';

const DAYS = 21;

export function PublicShell({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="q-wrap">
      <header className="q-top">
        <span className="brand"><span className="brand-mark"><Leaf size={18} /></span><span>LBC Care</span></span>
        <LangSwitch />
      </header>
      <div className="q-hero">
        <span className="q-hero-icon">{icon}</span>
        <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
      </div>
      {children}
    </main>
  );
}

interface Done { start_at: string; cancel_token: string; menuName: string }

export default function Book() {
  const { t } = useTranslation();
  const [done, setDone] = useState<Done | null>(null);
  const [key, setKey] = useState(0);
  return (
    <PublicShell icon={<CalendarDays size={26} />} title={t('book.title')} subtitle={done ? undefined : t('book.subtitle')}>
      {done ? <BookDone done={done} onAgain={() => { setDone(null); setKey((k) => k + 1); }} /> : <BookForm key={key} onDone={setDone} />}
    </PublicShell>
  );
}

function BookForm({ onDone }: { onDone: (d: Done) => void }) {
  const { t, i18n } = useTranslation();
  const lang = (['ja', 'pt', 'es'].includes(i18n.language) ? i18n.language : 'ja') as 'ja' | 'pt' | 'es';
  const menus = useMenus();
  const today = tokyoDate(new Date());
  const [menuId, setMenuId] = useState('');
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState('');
  const slots = useSlots(menuId || undefined, today, addDays(today, DAYS - 1));
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i)), [today]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '' });
  const [requestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const menu = menus.data?.find((m) => m.id === menuId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !/^0\d{9,10}$/.test(form.phone.replace(/\D/g, ''))) { setError(t('book.err_input')); return; }
    setBusy(true);
    try {
      const r = await callRpc<{ start_at: string; cancel_token: string }>('create_booking', {
        p: { request_id: requestId, store_id: STORE_ID, menu_id: menuId, start_at: slot, lang, ...form },
      });
      onDone({ start_at: r.start_at, cancel_token: r.cancel_token, menuName: menu ? pickName(menu.name, lang) : '' });
    } catch (err) {
      if (err instanceof BusinessError && err.code === 'slot_unavailable') {
        setError(t('book.err_slot'));
        setSlot('');
        void slots.refetch();
      } else if (err instanceof BusinessError && err.code === 'too_many_bookings') {
        setError(t('book.err_many'));
      } else if (err instanceof BusinessError) {
        setError(t('book.err_input'));
      } else {
        setError(t('book.err_net'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="q-form">
      <section className="card fade-in">
        <div className="card-head"><span className="icon"><Stethoscope size={18} /></span><h2>{t('book.step_menu')}</h2></div>
        <div className="card-body">
          {menus.isPending ? <Loading /> : (
            <div className="choice-grid">
              {menus.data?.map((m) => (
                <label key={m.id} className={`choice tile-choice ${menuId === m.id ? 'on' : ''}`}>
                  <input type="radio" name="menu" checked={menuId === m.id} onChange={() => { setMenuId(m.id); setSlot(''); }} />
                  <span className="choice-label">{pickName(m.name, lang)}</span>
                  <span className="choice-meta">{yen(m.price)} · {t('book.minutes', { n: m.duration_min })}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      {menuId && (
        <section className="card fade-in">
          <div className="card-head"><span className="icon"><CalendarDays size={18} /></span><h2>{t('book.step_date')}</h2></div>
          <div className="card-body">
            {slots.isPending ? <Loading /> : slots.isError ? <Alert kind="error">{t('book.err_net')}</Alert> : (
              <div className="date-strip">
                {days.map((d) => {
                  const n = slots.data?.get(d)?.length ?? 0;
                  return (
                    <button key={d} type="button" className={`date-chip ${date === d ? 'on' : ''}`} disabled={n === 0}
                            onClick={() => { setDate(d); setSlot(''); }}>
                      <span className="dc-day">{formatDate(d, lang)}</span>
                      <span className="dc-count">{n > 0 ? <><Check size={12} />{n}</> : '—'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {menuId && date && (
        <section className="card fade-in">
          <div className="card-head"><span className="icon"><Clock size={18} /></span><h2>{t('book.step_time')}</h2></div>
          <div className="card-body">
            {(slots.data?.get(date) ?? []).length === 0 ? <p className="muted">{t('book.noSlots')}</p> : (
              <div className="slot-grid">
                {slots.data!.get(date)!.map((s) => (
                  <button key={s.start_at} type="button" className={`slot ${slot === s.start_at ? 'on' : ''}`} onClick={() => setSlot(s.start_at)}>
                    {tokyoTime(s.start_at)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {slot && (
        <section className="card fade-in">
          <div className="card-head"><span className="icon"><UserRound size={18} /></span><h2>{t('book.step_info')}</h2></div>
          <div className="card-body">
            <label className="field"><span>{t('book.name')}</span>
              <input value={form.name} maxLength={60} autoComplete="name" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>{t('book.phone')}</span>
              <input type="tel" inputMode="numeric" value={form.phone} autoComplete="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="field"><span>{t('book.email')}</span>
              <input type="email" value={form.email} autoComplete="email" onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field"><span>{t('book.note')}</span>
              <textarea value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            <div className="receipt">
              <div className="receipt-row"><span>{t('book.step_menu')}</span><span>{menu ? pickName(menu.name, lang) : ''}</span></div>
              <div className="receipt-row"><span>{t('book.step_date')}</span><span>{formatDate(date, lang)} {tokyoTime(slot)}</span></div>
              {menu && <div className="receipt-total"><span>{t('record.lineTotal')}</span><strong>{yen(menu.price)}</strong></div>}
            </div>
            {error && <Alert kind="error">{error}</Alert>}
            <button className="btn-primary btn-lg btn-block" disabled={busy}><Send size={18} />{busy ? t('book.sending') : t('book.confirm')}</button>
          </div>
        </section>
      )}
      {!slot && error && <Alert kind="error">{error}</Alert>}
    </form>
  );
}

function BookDone({ done, onAgain }: { done: Done; onAgain: () => void }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/b/${done.cancel_token}`;
  return (
    <section className="card card-pad fade-in q-done">
      <CheckCircle2 size={56} color="var(--accent)" />
      <h1>{t('book.done')}</h1>
      <p className="muted">{t('book.doneMsg')}</p>
      <div className="receipt" style={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <div className="receipt-row"><span>{t('book.step_menu')}</span><span>{done.menuName}</span></div>
        <div className="receipt-row"><span>{t('book.step_date')}</span><span>{formatDate(tokyoDate(done.start_at), i18n.language)} {tokyoTime(done.start_at)}</span></div>
      </div>
      <div style={{ width: '100%', maxWidth: 420, display: 'grid', gap: 8 }}>
        <span className="label">{t('book.saveLink')}</span>
        <div className="inline">
          <input readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>
            <Copy size={16} />{copied ? t('book.copied') : t('book.copy')}
          </button>
        </div>
      </div>
      <button type="button" className="btn-ghost" onClick={onAgain}>{t('book.another')}</button>
    </section>
  );
}
