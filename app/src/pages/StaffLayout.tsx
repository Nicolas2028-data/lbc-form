import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, CloudUpload, Leaf, LogOut, Users } from 'lucide-react';
import { useAuth } from '../auth';
import { supabase } from '../lib/supabase';
import { useMe, errorText, type StaffMe } from '../lib/data';
import { flushOutbox, readOutbox } from '../lib/rpc';
import { LANGS, setLang, type Lang } from '../i18n';
import { Alert, ErrorBox, Loading } from '../ui';

const StaffContext = createContext<StaffMe | null>(null);
export const useStaff = () => useContext(StaffContext)!;

export function LangSwitch() {
  const { i18n } = useTranslation();
  return (
    <div className="lang" role="group" aria-label="language">
      {LANGS.map((l: Lang) => (
        <button key={l} type="button" className={i18n.language === l ? 'on' : ''} onClick={() => setLang(l)}>
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

// 送信待ちの件数を表示し、通信が戻ったら自動で送る
function OutboxBanner() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [count, setCount] = useState(() => readOutbox().length);
  const [failed, setFailed] = useState<string[]>([]);

  const flush = useCallback(async () => {
    const r = await flushOutbox();
    if (r.sent > 0) void qc.invalidateQueries();
    if (r.failed.length) {
      setFailed((f) => [...f, ...r.failed.map((x) => t('outbox.failed', { label: x.call.label, error: errorText(t, x.error) }))]);
    }
  }, [qc, t]);

  useEffect(() => {
    const update = () => setCount(readOutbox().length);
    window.addEventListener('lbc-outbox', update);
    window.addEventListener('online', flush);
    const timer = setInterval(() => { if (readOutbox().length) void flush(); }, 15_000);
    void flush();
    return () => {
      window.removeEventListener('lbc-outbox', update);
      window.removeEventListener('online', flush);
      clearInterval(timer);
    };
  }, [flush]);

  if (!count && !failed.length) return null;
  return (
    <div className="banner">
      {count > 0 && (
        <Alert kind="warn">
          <span className="inline">
            <CloudUpload size={16} /> {t('outbox.pending', { count })}
            <button type="button" className="btn-sm" onClick={() => void flush()}>{t('outbox.sendNow')}</button>
          </span>
        </Alert>
      )}
      {failed.map((f, i) => <Alert key={i} kind="error">{f}</Alert>)}
    </div>
  );
}

export default function StaffLayout() {
  const { t } = useTranslation();
  const { session, ready } = useAuth();
  const me = useMe(session?.user.id);

  if (!ready) return <Loading />;
  if (!session) return <Navigate to="/staff/login" replace />;
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

  return (
    <StaffContext.Provider value={staff}>
      <header className="app-header">
        <div className="app-header-inner">
          <Brand />
          <nav className="nav">
            <NavLink to="/staff" end><Users size={16} />{t('nav.patients')}</NavLink>
            <NavLink to="/staff/dashboard"><BarChart3 size={16} />{t('nav.dashboard')}</NavLink>
          </nav>
          <div className="header-right">
            <LangSwitch />
            <button type="button" className="btn-ghost btn-sm" onClick={() => void supabase.auth.signOut()} title={t('app.logout')}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>
      <OutboxBanner />
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/staff" end><Users size={22} />{t('nav.patients')}</NavLink>
        <NavLink to="/staff/dashboard"><BarChart3 size={22} />{t('nav.dashboard')}</NavLink>
      </nav>
    </StaffContext.Provider>
  );
}
