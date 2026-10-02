import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { supabase } from '../lib/supabase';
import { useMe, errorText, type StaffMe } from '../lib/data';
import { flushOutbox, readOutbox } from '../lib/rpc';
import { LANGS, setLang, type Lang } from '../i18n';

const StaffContext = createContext<StaffMe | null>(null);
export const useStaff = () => useContext(StaffContext)!;

export function LangSwitch() {
  const { i18n } = useTranslation();
  return (
    <div className="lang">
      {LANGS.map((l: Lang) => (
        <button key={l} type="button" className={i18n.language === l ? 'on' : ''} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
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
    <div className="banner warn">
      {count > 0 && (
        <span>
          {t('outbox.pending', { count })}{' '}
          <button type="button" onClick={() => void flush()}>{t('outbox.sendNow')}</button>
        </span>
      )}
      {failed.map((f, i) => <p key={i} className="error">{f}</p>)}
    </div>
  );
}

export default function StaffLayout() {
  const { t } = useTranslation();
  const { session, ready } = useAuth();
  const me = useMe(session?.user.id);

  if (!ready) return <main className="page"><p>{t('app.loading')}</p></main>;
  if (!session) return <Navigate to="/staff/login" replace />;
  if (me.isPending) return <main className="page"><p>{t('app.loading')}</p></main>;
  if (me.isError) {
    return (
      <main className="page">
        <p className="error">{errorText(t, me.error)}</p>
        <button onClick={() => void me.refetch()}>{t('app.retry')}</button>
      </main>
    );
  }
  const staff = me.data[0];
  if (!staff) {
    return (
      <main className="page narrow">
        <p className="error">{t('login.notStaff')}</p>
        <button onClick={() => void supabase.auth.signOut()}>{t('app.logout')}</button>
      </main>
    );
  }

  return (
    <StaffContext.Provider value={staff}>
      <header className="topbar">
        <span className="brand">🌿 {t('app.title')}</span>
        <nav>
          <NavLink to="/staff" end>{t('nav.patients')}</NavLink>
          <NavLink to="/staff/dashboard">{t('nav.dashboard')}</NavLink>
        </nav>
        <LangSwitch />
        <button type="button" className="link" onClick={() => void supabase.auth.signOut()}>{t('app.logout')}</button>
      </header>
      <OutboxBanner />
      <main className="page">
        <Outlet />
      </main>
    </StaffContext.Provider>
  );
}
