import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarCheck, ClipboardList, CloudUpload, FileText, Leaf, Lock, LogOut, RotateCw, Trash2, Users } from 'lucide-react';
import { useAuth } from '../auth';
import { supabase } from '../lib/supabase';
import { useMe, errorText, type StaffMe } from '../lib/data';
import { BusinessError, discardPending, flushOutbox, readOutbox, retryPending, type PendingCall } from '../lib/rpc';
import { LANGS, restoreSavedLang, setLang, type Lang } from '../i18n';
import { Alert, ErrorBox, Loading } from '../ui';

const StaffContext = createContext<StaffMe | null>(null);
export const useStaff = () => useContext(StaffContext)!;

// 問診モード: スタッフ画面から問診票をお客様に渡したとき、パスワードなしでスタッフ画面に戻れないようにする
const KIOSK_KEY = 'lbc_kiosk';
export const isKiosk = () => { try { return sessionStorage.getItem(KIOSK_KEY) === '1'; } catch { return false; } };
const setKiosk = (on: boolean) => { try { if (on) sessionStorage.setItem(KIOSK_KEY, '1'); else sessionStorage.removeItem(KIOSK_KEY); } catch { /* 保存できない環境 */ } };

/** persist=false: お客様が問診票で言語を変えても、スタッフ画面の言語は変えない */
export function LangSwitch({ persist = true }: { persist?: boolean }) {
  const { i18n } = useTranslation();
  return (
    <div className="lang" role="group" aria-label="language">
      {LANGS.map((l: Lang) => (
        <button key={l} type="button" className={i18n.language === l ? 'on' : ''} onClick={() => setLang(l, persist)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Brand() {
  return (
    <Link to="/staff" className="brand">
      <span className="brand-mark"><Leaf size={18} /></span>
      <span>LBC Care</span>
    </Link>
  );
}

function failedText(t: (k: string, o?: Record<string, unknown>) => string, c: PendingCall) {
  const err = c.lastError ?? '';
  return errorText(t as never, /^[a-z_]+(:.*)?$/.test(err) ? new BusinessError(err) : new Error(err));
}

// 送信待ちの件数と送信失敗の一覧。通信が戻ったら自動で送る
function OutboxBanner({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [items, setItems] = useState<PendingCall[]>(() => readOutbox());

  const flush = useCallback(async () => {
    const r = await flushOutbox();
    if (r.sent > 0) void qc.invalidateQueries();
  }, [qc]);

  useEffect(() => {
    const update = () => setItems(readOutbox());
    window.addEventListener('lbc-outbox', update);
    window.addEventListener('online', flush);
    const timer = setInterval(() => { if (readOutbox().some((c) => c.status === 'pending')) void flush(); }, 15_000);
    void flush();
    return () => {
      window.removeEventListener('lbc-outbox', update);
      window.removeEventListener('online', flush);
      clearInterval(timer);
    };
  }, [flush]);

  const mine = items.filter((c) => c.userId === userId);
  const pending = mine.filter((c) => c.status === 'pending');
  const failed = mine.filter((c) => c.status === 'failed');
  const others = items.length - mine.length;
  if (!pending.length && !failed.length && !others) return null;
  return (
    <div className="banner">
      {pending.length > 0 && (
        <Alert kind="warn">
          <span className="inline">
            <CloudUpload size={16} /> {t('outbox.pending', { count: pending.length })}
            <button type="button" className="btn-sm" onClick={() => void flush()}>{t('outbox.sendNow')}</button>
          </span>
        </Alert>
      )}
      {failed.map((c) => (
        <Alert key={c.payload.request_id} kind="error">
          <div className="inline">
            <span>{t('outbox.failed', { label: c.label, error: failedText(t, c) })}</span>
            <button type="button" className="btn-sm" onClick={() => { retryPending(c.payload.request_id); void flush(); }}>
              <RotateCw size={14} />{t('outbox.retry')}
            </button>
            <button type="button" className="btn-sm btn-danger" onClick={() => discardPending(c.payload.request_id)}>
              <Trash2 size={14} />{t('outbox.discard')}
            </button>
          </div>
        </Alert>
      ))}
      {others > 0 && <Alert kind="info">{t('outbox.otherUser', { count: others })}</Alert>}
    </div>
  );
}

function LogoutButton({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const pending = readOutbox().filter((c) => c.userId === userId).length;
  const logout = async () => {
    await supabase.auth.signOut();
    qc.clear();
  };
  if (confirm) {
    return (
      <span className="inline">
        <span className="small">{t('outbox.logoutWarn', { count: pending })}</span>
        <button type="button" className="btn-sm btn-danger" onClick={() => void logout()}>{t('app.logout')}</button>
        <button type="button" className="btn-sm btn-ghost" onClick={() => setConfirm(false)}>×</button>
      </span>
    );
  }
  return (
    <button type="button" className="btn-ghost btn-sm" title={t('app.logout')}
            onClick={() => (pending > 0 ? setConfirm(true) : void logout())}>
      <LogOut size={16} />
    </button>
  );
}

// 問診モードの解除(ログイン中のスタッフのパスワードを入れ直す)
function KioskLock({ email }: { email: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function unlock(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setError(t('login.failed')); return; }
    setKiosk(false);
    restoreSavedLang();
    navigate('/staff', { replace: true });
  }
  return (
    <main className="auth-wrap">
      <form className="card auth-card fade-in" onSubmit={unlock}>
        <div className="auth-top"><Brand /><Lock size={20} /></div>
        <h1>{t('kiosk.lockedTitle')}</h1>
        <p className="muted">{t('kiosk.lockedHint')}</p>
        <label className="field">
          <span>{t('login.password')}</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn-primary btn-lg btn-block">{t('kiosk.unlock')}</button>
        <button type="button" className="btn-ghost" onClick={() => navigate('/q', { replace: true })}>{t('kiosk.backToQ')}</button>
      </form>
    </main>
  );
}

export default function StaffLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { session, ready } = useAuth();
  const me = useMe(session?.user.id);

  if (!ready) return <Loading />;
  if (!session) return <Navigate to="/staff/login" replace />;
  if (isKiosk()) return <KioskLock email={session.user.email ?? ''} />;
  if (me.isPending) return <Loading />;
  if (me.isError) return <main className="page"><ErrorBox text={errorText(t, me.error)} onRetry={() => void me.refetch()} /></main>;
  const staff = me.data[0];
  if (!staff) {
    return (
      <main className="page page-narrow">
        <Alert kind="error">{t('login.notStaff')}</Alert>
        <button onClick={() => void supabase.auth.signOut()}><LogOut size={16} />{t('app.logout')}</button>
      </main>
    );
  }
  const openKiosk = () => { setKiosk(true); navigate('/q', { replace: true }); };

  return (
    <StaffContext.Provider value={staff}>
      <header className="app-header">
        <div className="app-header-inner">
          <Brand />
          <nav className="nav">
            <NavLink to="/staff" end><CalendarCheck size={16} />{t('nav.today')}</NavLink>
            <NavLink to="/staff/patients"><Users size={16} />{t('nav.patients')}</NavLink>
            <NavLink to="/staff/charts"><FileText size={16} />{t('nav.charts')}</NavLink>
            <NavLink to="/staff/dashboard"><BarChart3 size={16} />{t('nav.dashboard')}</NavLink>
          </nav>
          <div className="header-right">
            <button type="button" className="btn-sm" onClick={openKiosk} title={t('kiosk.open')}><ClipboardList size={16} />{t('kiosk.open')}</button>
            <LangSwitch />
            <LogoutButton userId={session.user.id} />
          </div>
        </div>
      </header>
      <OutboxBanner userId={session.user.id} />
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/staff" end><CalendarCheck size={22} />{t('nav.today')}</NavLink>
        <NavLink to="/staff/patients"><Users size={22} />{t('nav.patients')}</NavLink>
        <NavLink to="/staff/charts"><FileText size={22} />{t('nav.charts')}</NavLink>
        <NavLink to="/staff/dashboard"><BarChart3 size={22} />{t('nav.dashboard')}</NavLink>
      </nav>
    </StaffContext.Provider>
  );
}
