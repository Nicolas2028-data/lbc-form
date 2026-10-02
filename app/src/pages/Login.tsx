import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth';
import { LangSwitch } from './StaffLayout';

export default function Login() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/staff" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(t('login.failed'));
  }

  return (
    <main className="page narrow">
      <div className="topbar"><span className="brand">🌿 {t('app.title')}</span><LangSwitch /></div>
      <form className="card" onSubmit={submit}>
        <h1>{t('login.title')}</h1>
        <label className="field">
          <span>{t('login.email')}</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input type="password" autoComplete="current-password" required value={password}
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? t('app.loading') : t('login.submit')}</button>
      </form>
    </main>
  );
}
