import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomers, useMenus, usePatientCard, useProducts, errorText, searchKey, type PatientCard } from '../lib/data';
import { sendMutation, newRequestId, BusinessError } from '../lib/rpc';
import { calcPrice, yen } from '../lib/pricing';
import { pickName } from '../i18n';
import {
  ArrowLeft, Banknote, CalendarCheck, CheckCircle2, CircleSlash, Clock, CreditCard, IdCard, Minus, NotebookPen,
  Plus, Receipt, Send, Smartphone, Sparkles, Stethoscope, Ticket, Undo2, UserPlus, Wallet, X,
} from 'lucide-react';
import { Alert, Avatar, Card, ErrorBox, Loading } from '../ui';

type Payment = 'cash' | 'card' | 'paypay' | 'unpaid' | 'other';
const PAYMENTS: Payment[] = ['cash', 'card', 'paypay', 'unpaid', 'other'];
const PAYMENT_ICONS = { cash: Banknote, card: CreditCard, paypay: Smartphone, unpaid: Clock, other: Receipt };

interface RecordResult { total: number; referral_limit_reached?: boolean; duplicate?: boolean }

export default function Record() {
  const { customerId } = useParams();
  const { t } = useTranslation();
  const card = usePatientCard(customerId);
  // 記録が終わったら(送信待ちになった場合も)入力欄を新しくする。メッセージはフォームの外で保持
  const [formKey, setFormKey] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  // フォームを開いているか。null = 当日の記録の有無で決める(記録済みなら閉じた状態で開始)
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  // この画面で記録した(送信待ちを含む)。同じ日の 2 件目かどうかの判定に使う
  const [recordedHere, setRecordedHere] = useState(false);

  if (card.isPending) return <Loading />;
  if (card.isError) return <ErrorBox text={errorText(t, card.error)} onRetry={() => void card.refetch()} />;
  const hasToday = recordedHere || card.data.today_visits.some((v) => v.status === 'recorded');
  return (
    <RecordForm
      key={`${card.data.customer.id}:${formKey}`}
      card={card.data}
      message={message}
      open={formOpen ?? !hasToday}
      allowSameDay={hasToday}
      onOpen={() => { setMessage(null); setFormOpen(true); setFormKey((k) => k + 1); }}
      onMessage={setMessage}
      onDone={(m) => { setMessage(m); setRecordedHere(true); setFormOpen(false); setFormKey((k) => k + 1); }}
    />
  );
}

interface Message { kind: 'ok' | 'error' | 'warn'; text: string }

interface FormProps {
  card: PatientCard;
  message: Message | null;
  open: boolean;           // false なら記録フォームを出さず「記録済み」表示にする
  allowSameDay: boolean;   // 当日すでに記録がある患者への 2 件目
  onOpen: () => void;
  onMessage: (m: Message | null) => void;
  onDone: (m: Message) => void;
}

function RecordForm({ card, message, open, allowSameDay, onOpen, onMessage: setMessage, onDone }: FormProps) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const menus = useMenus();
  const products = useProducts();
  const customers = useCustomers();
  const lang = i18n.language;

  const [requestId] = useState(newRequestId); // 再送しても同じ ID(二重記録防止)
  const [attended, setAttended] = useState(true);
  const [noShowReason, setNoShowReason] = useState('');
  const [change, setChange] = useState<'none' | 'changed' | ''>('');
  const [menuId, setMenuId] = useState('');
  const [passId, setPassId] = useState('');
  const [buyId, setBuyId] = useState('');
  const [useNow, setUseNow] = useState(true);
  const [payment, setPayment] = useState<Payment | ''>('');
  const [creditUse, setCreditUse] = useState(0);
  const [referrerId, setReferrerId] = useState('');
  const [referrerQuery, setReferrerQuery] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);

  const menu = menus.data?.find((m) => m.id === menuId);
  const product = products.data?.find((p) => p.id === buyId);
  const referral = card.is_first_visit && !!referrerId;
  const price = calcPrice({
    menuPrice: menu?.price ?? 0,
    coveredByPass: !!passId || (!!buyId && useNow),
    productPrice: product?.price ?? 0,
    referral,
    creditUse,
  });
  const maxCredit = Math.min(price.maxCredit, card.credit_available);

  const referrerHits = useMemo(() => {
    const k = searchKey(referrerQuery);
    if (!k) return [];
    return (customers.data ?? [])
      .filter((c) => c.id !== card.customer.id)
      .filter((c) => [c.name, c.furigana, c.code].some((v) => searchKey(v).includes(k)))
      .slice(0, 6);
  }, [customers.data, referrerQuery, card.customer.id]);
  const referrer = customers.data?.find((c) => c.id === referrerId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (attended ? !menuId || (price.total > 0 && !payment) : !noShowReason.trim()) {
      setMessage({ kind: 'error', text: t('record.required') });
      return;
    }
    const payload = {
      request_id: requestId,
      customer_id: card.customer.id,
      attended,
      no_show_reason: attended ? null : noShowReason,
      change_from_last: change || null,
      menu_id: attended ? menuId : null,
      use_pass_id: attended && passId ? passId : null,
      purchase_product_id: attended && buyId ? buyId : null,
      use_purchased_pass: attended && !!buyId && useNow && !passId,
      payment_method: attended && price.total > 0 ? payment : null,
      credit_use: attended ? price.creditUse : 0,
      referrer_id: attended && referral ? referrerId : null,
      memo,
      allow_same_day: allowSameDay,
    };
    setBusy(true);
    try {
      const r = await sendMutation<RecordResult>('record_visit', payload, `${card.customer.name} ${menu ? pickName(menu.name, lang) : ''}`);
      if (r.queued) {
        onDone({ kind: 'warn', text: t('record.queued') });
      } else {
        const text = `${t('record.saved')}(${yen(r.data.total)})`
          + (r.data.referral_limit_reached ? ` — ${t('record.referralLimit')}` : '');
        onDone({ kind: 'ok', text });
        void qc.invalidateQueries({ queryKey: ['patient-card', card.customer.id] });
        void qc.invalidateQueries({ queryKey: ['monthly-stats'] });
      }
    } catch (err) {
      if (err instanceof BusinessError && err.code === 'already_recorded_today') {
        // 別の端末などで先に記録されていた → 記録済み表示に切り替える
        onDone({ kind: 'warn', text: errorText(t, err) });
        void qc.invalidateQueries({ queryKey: ['patient-card', card.customer.id] });
      } else {
        setMessage({ kind: 'error', text: errorText(t, err) });
      }
    } finally {
      setBusy(false);
    }
  }

  const recordedToday = card.today_visits.filter((v) => v.status === 'recorded').length;

  return (
    <>
      <div className="inline">
        <Link to="/staff" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}><ArrowLeft size={16} />{t('app.back')}</Link>
        <span className="spacer" />
        <Link to={`/staff/customers/${card.customer.id}`} className="btn btn-sm" style={{ textDecoration: 'none' }}>
          <IdCard size={16} />{t('record.detail')}
        </Link>
      </div>

      <section className="card fade-in">
        <div className="hero">
          <Avatar name={card.customer.name} seed={card.customer.id} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{card.customer.name}</h1>
            <div className="hero-meta">
              <span className="badge mono">{card.customer.code}</span>
              {card.is_first_visit
                ? <span className="badge badge-info"><Sparkles size={13} />{t('record.firstVisit')}</span>
                : <span className="badge">{t('record.visitCount', { count: card.visit_count + 1 })}</span>}
              {card.last_visit_before_today && <span className="badge">{t('record.lastVisit', { date: card.last_visit_before_today })}</span>}
              {recordedToday > 0 && <span className="badge badge-accent"><CheckCircle2 size={13} />{t('record.alreadyToday')}</span>}
            </div>
          </div>
        </div>
        <div className="stats-row">
          <div><div className="k">{t('customer.credit')}</div><div className="v">{yen(card.credit_available)}</div></div>
          <div><div className="k">{t('record.pass')}</div><div className="v">{card.passes.length ? card.passes.map((p) => `${pickName(p.name, lang)} ×${p.remaining}`).join(' / ') : '—'}</div></div>
        </div>
      </section>

      {card.credit_expiring.map((x) => (
        <Alert key={x.expires_on} kind="warn">{t('record.creditExpiring', { date: x.expires_on, amount: yen(x.amount) })}</Alert>
      ))}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {!open ? (
        <section className="card card-pad fade-in" style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
          <div className="inline"><CheckCircle2 size={20} color="var(--accent)" /><h2>{t('record.alreadyToday')}</h2></div>
          <p className="muted">{t('record.addAnotherHint')}</p>
          <button type="button" onClick={onOpen}><Plus size={16} />{t('record.addAnother')}</button>
        </section>
      ) : (
      <form id="record-form" onSubmit={submit} style={{ display: 'grid', gap: 20 }}>
        {allowSameDay && <Alert kind="warn">{t('record.sameDayNotice')}</Alert>}

        <Card title={t('record.section_status')} icon={<CalendarCheck size={18} />}>
          <div className="segmented">
            <button type="button" className={attended ? 'on good' : ''} onClick={() => setAttended(true)}><CheckCircle2 size={16} />{t('record.attended')}</button>
            <button type="button" className={!attended ? 'on bad' : ''} onClick={() => setAttended(false)}><CircleSlash size={16} />{t('record.noShow')}</button>
          </div>
          <div className="field">
            <span>{t('record.change')}</span>
            <div className="segmented">
              <button type="button" className={change === 'none' ? 'on' : ''} onClick={() => setChange(change === 'none' ? '' : 'none')}>{t('record.changeNone')}</button>
              <button type="button" className={change === 'changed' ? 'on bad' : ''} onClick={() => setChange(change === 'changed' ? '' : 'changed')}>{t('record.changeYes')}</button>
            </div>
          </div>
          {!attended && (
            <label className="field">
              <span>{t('record.noShowReason')}</span>
              <textarea value={noShowReason} onChange={(e) => setNoShowReason(e.target.value)} rows={3} />
            </label>
          )}
        </Card>

        {attended && (
          <Card title={t('record.section_menu')} icon={<Stethoscope size={18} />}>
            <div className="choice-grid">
              {menus.data?.map((m) => (
                <label key={m.id} className={`choice tile-choice ${menuId === m.id ? 'on' : ''}`}>
                  <input type="radio" name="menu" checked={menuId === m.id} onChange={() => setMenuId(m.id)} />
                  <span className="choice-label">{pickName(m.name, lang)}</span>
                  <span className="choice-meta">{yen(m.price)}</span>
                </label>
              ))}
            </div>

            {card.passes.length > 0 && (
              <div className="field">
                <span>{t('record.pass')}</span>
                <div className="choice-grid">
                  {card.passes.map((p) => (
                    <label key={p.id} className={`choice ${passId === p.id ? 'on' : ''}`}>
                      <input type="checkbox" checked={passId === p.id}
                             onChange={(e) => { setPassId(e.target.checked ? p.id : ''); if (e.target.checked) setUseNow(false); }} />
                      <Ticket size={18} />
                      <span className="choice-label">{pickName(p.name, lang)}</span>
                      <span className="choice-meta">{t('record.usePass', { remaining: p.remaining, until: p.valid_until })}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {(products.data?.length ?? 0) > 0 && (
              <div className="field">
                <span>{t('record.buyProduct')}</span>
                <select value={buyId} onChange={(e) => setBuyId(e.target.value)}>
                  <option value="">{t('record.buyNone')}</option>
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>{pickName(p.name, lang)}({yen(p.price)})</option>
                  ))}
                </select>
                {buyId && !passId && (
                  <label className="check"><input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} />{t('record.useNow')}</label>
                )}
              </div>
            )}
          </Card>
        )}

        {attended && (
          <Card title={t('record.section_payment')} icon={<Wallet size={18} />}>
            {card.is_first_visit && (
              <div className="field">
                <span>{t('record.referral')}</span>
                {referrer ? (
                  <div className="choice on">
                    <Avatar name={referrer.name} seed={referrer.id} />
                    <span className="choice-label">{referrer.name}</span>
                    <span className="badge mono">{referrer.code}</span>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setReferrerId('')}><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <label className="search">
                      <UserPlus size={18} />
                      <input type="search" placeholder={t('record.referralSearch')} value={referrerQuery}
                             onChange={(e) => setReferrerQuery(e.target.value)} style={{ minHeight: 44, fontSize: '1rem' }} />
                    </label>
                    {referrerHits.length > 0 && (
                      <ul className="list card">
                        {referrerHits.map((c) => (
                          <li key={c.id}>
                            <button type="button" className="list-item" onClick={() => { setReferrerId(c.id); setReferrerQuery(''); setCreditUse(0); }}>
                              <Avatar name={c.name} seed={c.id} />
                              <span className="list-main"><span className="list-title">{c.name}</span></span>
                              <span className="badge mono">{c.code}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}

            {card.credit_available > 0 && !referral && (
              <div className="field">
                <span>{t('record.credit')} · {t('record.creditAvailable', { amount: yen(card.credit_available) })}</span>
                <div className="inline">
                  <div className="stepper">
                    <button type="button" onClick={() => setCreditUse(Math.max(creditUse - 500, 0))}><Minus size={16} /></button>
                    <strong>{yen(price.creditUse)}</strong>
                    <button type="button" onClick={() => setCreditUse(Math.min(creditUse + 500, maxCredit))}><Plus size={16} /></button>
                  </div>
                  <button type="button" className="btn-sm" onClick={() => setCreditUse(maxCredit)}>MAX</button>
                </div>
              </div>
            )}

            {price.total > 0 && (
              <div className="field">
                <span>{t('record.payment')}</span>
                <div className="choice-grid compact">
                  {PAYMENTS.map((p) => {
                    const Icon = PAYMENT_ICONS[p];
                    return (
                      <label key={p} className={`choice ${payment === p ? 'on' : ''}`}>
                        <input type="radio" name="payment" checked={payment === p} onChange={() => setPayment(p)} />
                        <Icon size={18} /><span className="choice-label">{t(`record.${p}`)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {menu && (
              <div className="receipt">
                {price.menuCharge > 0 && <div className="receipt-row"><span>{t('record.lineMenu')}</span><span>{yen(price.menuCharge)}</span></div>}
                {price.productCharge > 0 && <div className="receipt-row"><span>{t('record.lineProduct')}</span><span>{yen(price.productCharge)}</span></div>}
                {price.referralDiscount > 0 && <div className="receipt-row minus"><span>{t('record.lineReferral')}</span><span>−{yen(price.referralDiscount)}</span></div>}
                {price.creditUse > 0 && <div className="receipt-row minus"><span>{t('record.lineCredit')}</span><span>−{yen(price.creditUse)}</span></div>}
                <div className="receipt-total"><span>{t('record.lineTotal')}</span><strong>{yen(price.total)}</strong></div>
              </div>
            )}
          </Card>
        )}

        <Card title={t('record.section_note')} icon={<NotebookPen size={18} />}>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={4} placeholder={t('record.memo')} />
        </Card>

        <div className="action-bar">
          <div className="action-bar-inner">
            <div>
              <div className="total-label">{t('record.lineTotal')}</div>
              <div className="total-value">{attended ? yen(price.total) : '—'}</div>
            </div>
            <button className="btn-primary btn-lg" disabled={busy}>
              <Send size={18} />{busy ? t('record.sending') : t('record.submit')}
            </button>
          </div>
        </div>
      </form>
      )}

      <TodayVisits card={card} />
    </>
  );
}

function TodayVisits({ card }: { card: PatientCard }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const menus = useMenus();
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  if (!card.today_visits.length) return null;

  async function confirmVoid(visitId: string) {
    if (!reason.trim()) { setMessage({ kind: 'error', text: t('errors.void_reason_required') }); return; }
    try {
      const r = await sendMutation('void_visit', { visit_id: visitId, reason }, `void ${card.customer.name}`);
      setMessage(r.queued ? { kind: 'warn', text: t('record.queued') } : { kind: 'ok', text: t('record.voidDone') });
      setVoiding(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['patient-card', card.customer.id] });
      await qc.invalidateQueries({ queryKey: ['monthly-stats'] });
      await qc.invalidateQueries({ queryKey: ['visits', card.customer.id] });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(t, err) });
    }
  }

  return (
    <Card title={t('record.today')} icon={<Clock size={18} />} pad={false}>
      {message && <div className="card-body"><Alert kind={message.kind}>{message.text}</Alert></div>}
      <div className="timeline">
        {card.today_visits.map((v) => {
          const m = menus.data?.find((x) => x.id === v.menu_id);
          return (
            <div key={v.id} className={`timeline-item ${v.status === 'voided' ? 'voided' : ''}`}>
              <span className="tl-amount">{yen(v.total)}</span>
              <div>
                <div className="tl-title">{v.attended ? (m ? pickName(m.name, i18n.language) : '—') : t('record.noShow')}</div>
                {v.memo && <div className="tl-sub">{v.memo}</div>}
                {voiding === v.id && (
                  <div className="inline" style={{ marginTop: 10 }}>
                    <input placeholder={t('record.voidReason')} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                    <button type="button" className="btn-danger btn-sm" onClick={() => void confirmVoid(v.id)}><Undo2 size={14} />{t('record.void')}</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setVoiding(null)}><X size={14} /></button>
                  </div>
                )}
              </div>
              {v.status === 'voided'
                ? <span className="badge badge-danger">{t('record.voided')}</span>
                : voiding !== v.id && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => { setVoiding(v.id); setMessage(null); }}>
                    <Undo2 size={14} />{t('record.void')}
                  </button>
                )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
