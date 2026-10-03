// お客様: 予約の確認・キャンセル(予約時に渡したリンク /b/<token>)
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BusinessError } from '../lib/rpc';
import { callRpc, formatDate, tokyoDate, tokyoTime } from '../lib/booking';
import { pickName } from '../i18n';
import { Alert, Loading } from '../ui';
import { PublicShell } from './Book';

interface Info { start_at: string; end_at: string; status: string; menu_name: Record<string, string>; can_cancel: boolean }

export default function BookingManage() {
  const { token } = useParams();
  const { t, i18n } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const info = useQuery({
    queryKey: ['booking-token', token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_booking_by_token', { p_token: token });
      if (error) throw new Error(error.message);
      return data as Info | null;
    },
  });

  async function cancel() {
    try {
      await callRpc('cancel_booking', { p: { cancel_token: token } });
      setMsg({ kind: 'ok', text: t('book.cancelled') });
      void info.refetch();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof BusinessError && e.code === 'cancel_deadline_passed' ? t('book.cancelDeadline') : t('book.err_net') });
    } finally {
      setConfirm(false);
    }
  }

  return (
    <PublicShell icon={<CalendarCheck size={26} />} title={t('book.cancelTitle')}>
      {info.isPending ? <Loading /> : !info.data ? <Alert kind="error">{t('book.notFound')}</Alert> : (
        <section className="card card-pad fade-in" style={{ display: 'grid', gap: 16 }}>
          <span className={`badge ${info.data.status === 'confirmed' ? 'badge-accent' : 'badge-danger'}`} style={{ justifySelf: 'start' }}>
            {t(`book.status_${info.data.status}`)}
          </span>
          <div className="receipt">
            <div className="receipt-row"><span>{t('book.step_menu')}</span><span>{pickName(info.data.menu_name, i18n.language)}</span></div>
            <div className="receipt-row"><span>{t('book.step_date')}</span>
              <span>{formatDate(tokyoDate(info.data.start_at), i18n.language)} {tokyoTime(info.data.start_at)}–{tokyoTime(info.data.end_at)}</span></div>
          </div>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          {info.data.status === 'confirmed' && (info.data.can_cancel ? (
            confirm ? (
              <Alert kind="warn">
                <div style={{ display: 'grid', gap: 10 }}>
                  <span>{t('book.cancelConfirm')}</span>
                  <div className="inline">
                    <button type="button" className="btn-danger" onClick={() => void cancel()}><XCircle size={16} />{t('book.cancel')}</button>
                    <button type="button" className="btn-ghost" onClick={() => setConfirm(false)}>{t('customer.cancel')}</button>
                  </div>
                </div>
              </Alert>
            ) : <button type="button" className="btn-danger" onClick={() => setConfirm(true)}><XCircle size={16} />{t('book.cancel')}</button>
          ) : <Alert kind="warn">{t('book.cancelDeadline')}</Alert>)}
        </section>
      )}
    </PublicShell>
  );
}
