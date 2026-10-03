import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth';
import { Brand, LangSwitch } from './StaffLayout';
import { Alert } from '../ui';

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
    <main className="auth-wrap">
      <form className="card auth-card fade-in" onSubmit={submit}>
        <div className="auth-top"><Brand /><LangSwitch /></div>
        <div>
          <h1>{t('login.title')}</h1>
        </div>
        <label className="field">
          <span>{t('login.email')}</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input type="password" autoComplete="current-password" required value={password}
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn-primary btn-lg btn-block" disabled={busy}>
          <LogIn size={18} />{busy ? t('app.loading') : t('login.submit')}
        </button>
      </form>
    </main>
  );
}
