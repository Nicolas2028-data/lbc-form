// 共通の小さな UI 部品
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, RotateCw } from 'lucide-react';

const AVATAR_COLORS = [
  ['#2fa36f', '#1f7a57'], ['#5b8def', '#3a63c8'], ['#e7804a', '#c55a26'], ['#a66be0', '#7c45b8'],
  ['#e05c8a', '#b83a65'], ['#2fb3c4', '#1b8796'], ['#c9a227', '#9c7a12'], ['#6b7280', '#4b5563'],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, seed, size }: { name: string; seed: string; size?: 'lg' }) {
  const [a, b] = AVATAR_COLORS[hash(seed) % AVATAR_COLORS.length];
  // 日本語などは 1 文字(姓の頭)、ローマ字は姓名の頭文字 2 つ
  const trimmed = name.trim();
  const initials = /[぀-ヿ㐀-鿿]/.test(trimmed)
    ? trimmed[0]
    : trimmed.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className={`avatar ${size === 'lg' ? 'avatar-lg' : ''}`} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} aria-hidden>
      {initials || '?'}
    </span>
  );
}

/** 数字を 0 からふわっと数え上げて表示する(動きを減らす設定では最初から最終値) */
export function CountUp({ value, format = (n: number) => String(n), ms = 1100 }: { value: number; format?: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - start) / ms, 1);
      setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

type AlertKind = 'ok' | 'error' | 'warn' | 'info';
const ALERT_ICONS = { ok: CheckCircle2, error: AlertCircle, warn: AlertTriangle, info: Info };

export function Alert({ kind, children }: { kind: AlertKind; children: ReactNode }) {
  const Icon = ALERT_ICONS[kind];
  return (
    <div className={`alert alert-${kind} fade-in`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <Loader2 size={22} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
      <span>{t('app.loading')}</span>
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert kind="error">
      <div className="inline">
        <span>{text}</span>
        <button type="button" className="btn-sm" onClick={onRetry}><RotateCw size={14} />{t('app.retry')}</button>
      </div>
    </Alert>
  );
}

export function Card({ title, icon, actions, children, pad = true }: {
  title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean;
}) {
  return (
    <section className="card fade-in">
      {title && (
        <div className="card-head">
          {icon && <span className="icon">{icon}</span>}
          <h2>{title}</h2>
          {actions && <div className="spacer" />}
          {actions}
        </div>
      )}
      {pad ? <div className="card-body">{children}</div> : children}
    </section>
  );
}
