import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomers, useMenus, usePatientCard, useProducts, errorText, searchKey, type PatientCard } from '../lib/data';
import { sendMutation, newRequestId } from '../lib/rpc';
import { calcPrice, yen } from '../lib/pricing';
import { pickName } from '../i18n';

type Payment = 'cash' | 'card' | 'paypay' | 'unpaid' | 'other';
const PAYMENTS: Payment[] = ['cash', 'card', 'paypay', 'unpaid', 'other'];

interface RecordResult { total: number; referral_limit_reached?: boolean; duplicate?: boolean }

export default function Record() {
  const { customerId } = useParams();
  const { t } = useTranslation();
  const card = usePatientCard(customerId);
  // 記録が終わったら(送信待ちになった場合も)入力欄を新しくする。メッセージはフォームの外で保持
  const [formKey, setFormKey] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);

  if (card.isPending) return <p>{t('app.loading')}</p>;
  if (card.isError) {
    return (
      <p className="error">
        {errorText(t, card.error)} <button onClick={() => void card.refetch()}>{t('app.retry')}</button>
      </p>
    );
  }
  return (
    <RecordForm
      key={`${card.data.customer.id}:${formKey}`}
      card={card.data}
      message={message}
      onMessage={setMessage}
      onDone={(m) => { setMessage(m); setFormKey((k) => k + 1); }}
    />
  );
}

interface Message { kind: 'ok' | 'error' | 'warn'; text: string }

interface FormProps {
  card: PatientCard;
  message: Message | null;
  onMessage: (m: Message | null) => void;
  onDone: (m: Message) => void;
}

function RecordForm({ card, message, onMessage: setMessage, onDone }: FormProps) {
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
      setMessage({ kind: 'error', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link to="/staff" className="link">← {t('app.back')}</Link>
      <section className="card patient">
        <h1>{card.customer.name} <span className="code">{card.customer.code}</span></h1>
        <p className="muted">
          {card.is_first_visit ? t('record.firstVisit') : t('record.visitCount', { count: card.visit_count + 1 })}
          {card.last_visit_before_today && ` · ${t('record.lastVisit', { date: card.last_visit_before_today })}`}
          {` · ${t('record.creditAvailable', { amount: yen(card.credit_available) })}`}
        </p>
        {card.credit_expiring.map((x) => (
          <p key={x.expires_on} className="warn-text">{t('record.creditExpiring', { date: x.expires_on, amount: yen(x.amount) })}</p>
        ))}
      </section>

      {message && <p className={`message ${message.kind}`}>{message.text}</p>}

      <form className="card" onSubmit={submit}>
        <h2>{t('record.title')}</h2>

        <div className="segmented">
          <button type="button" className={attended ? 'on' : ''} onClick={() => setAttended(true)}>✅ {t('record.attended')}</button>
          <button type="button" className={!attended ? 'on' : ''} onClick={() => setAttended(false)}>⚫ {t('record.noShow')}</button>
        </div>

        <fieldset>
          <legend>{t('record.change')}</legend>
          <div className="segmented">
            <button type="button" className={change === 'none' ? 'on' : ''} onClick={() => setChange(change === 'none' ? '' : 'none')}>{t('record.changeNone')}</button>
            <button type="button" className={change === 'changed' ? 'on' : ''} onClick={() => setChange(change === 'changed' ? '' : 'changed')}>{t('record.changeYes')}</button>
          </div>
        </fieldset>

        {!attended ? (
          <label className="field">
            <span>{t('record.noShowReason')}</span>
            <textarea value={noShowReason} onChange={(e) => setNoShowReason(e.target.value)} rows={3} />
          </label>
        ) : (
          <>
            <fieldset>
              <legend>{t('record.menu')}</legend>
              <div className="options">
                {menus.data?.map((m) => (
                  <label key={m.id} className={`option ${menuId === m.id ? 'on' : ''}`}>
                    <input type="radio" name="menu" checked={menuId === m.id} onChange={() => setMenuId(m.id)} />
                    <span>{pickName(m.name, lang)}</span><span className="price">{yen(m.price)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {card.passes.length > 0 && (
              <fieldset>
                <legend>{t('record.pass')}</legend>
                {card.passes.map((p) => (
                  <label key={p.id} className={`option ${passId === p.id ? 'on' : ''}`}>
                    <input type="checkbox" checked={passId === p.id}
                           onChange={(e) => { setPassId(e.target.checked ? p.id : ''); if (e.target.checked) setUseNow(false); }} />
                    <span>{pickName(p.name, lang)} — {t('record.usePass', { remaining: p.remaining, until: p.valid_until })}</span>
                  </label>
                ))}
              </fieldset>
            )}

            {(products.data?.length ?? 0) > 0 && (
              <fieldset>
                <legend>{t('record.buyProduct')}</legend>
                <select value={buyId} onChange={(e) => setBuyId(e.target.value)}>
                  <option value="">{t('record.buyNone')}</option>
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>{pickName(p.name, lang)}({yen(p.price)})</option>
                  ))}
                </select>
                {buyId && !passId && (
                  <label className="check">
                    <input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} /> {t('record.useNow')}
                  </label>
                )}
              </fieldset>
            )}

            {card.is_first_visit && (
              <fieldset>
                <legend>{t('record.referral')}</legend>
                {referrer ? (
                  <p>
                    {referrer.name} <span className="code">{referrer.code}</span>{' '}
                    <button type="button" onClick={() => setReferrerId('')}>{t('record.referralNone')}</button>
                  </p>
                ) : (
                  <>
                    <input type="search" placeholder={t('record.referralSearch')} value={referrerQuery}
                           onChange={(e) => setReferrerQuery(e.target.value)} />
                    <ul className="list compact">
                      {referrerHits.map((c) => (
                        <li key={c.id}>
                          <button type="button" onClick={() => { setReferrerId(c.id); setReferrerQuery(''); setCreditUse(0); }}>
                            {c.name} <span className="code">{c.code}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </fieldset>
            )}

            {card.credit_available > 0 && !referral && (
              <fieldset>
                <legend>{t('record.credit')}({t('record.creditAvailable', { amount: yen(card.credit_available) })})</legend>
                <div className="stepper">
                  <button type="button" onClick={() => setCreditUse(Math.max(creditUse - 500, 0))}>−500</button>
                  <strong>{yen(price.creditUse)}</strong>
                  <button type="button" onClick={() => setCreditUse(Math.min(creditUse + 500, maxCredit))}>+500</button>
                  <button type="button" onClick={() => setCreditUse(maxCredit)}>MAX</button>
                </div>
              </fieldset>
            )}

            {price.total > 0 && (
              <fieldset>
                <legend>{t('record.payment')}</legend>
                <div className="options row">
                  {PAYMENTS.map((p) => (
                    <label key={p} className={`option ${payment === p ? 'on' : ''}`}>
                      <input type="radio" name="payment" checked={payment === p} onChange={() => setPayment(p)} />
                      <span>{t(`record.${p}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {menu && (
              <div className="summary">
                <h3>{t('record.summary')}</h3>
                {price.menuCharge > 0 && <p><span>{t('record.lineMenu')}</span><span>{yen(price.menuCharge)}</span></p>}
                {price.productCharge > 0 && <p><span>{t('record.lineProduct')}</span><span>{yen(price.productCharge)}</span></p>}
                {price.referralDiscount > 0 && <p className="minus"><span>{t('record.lineReferral')}</span><span>−{yen(price.referralDiscount)}</span></p>}
                {price.creditUse > 0 && <p className="minus"><span>{t('record.lineCredit')}</span><span>−{yen(price.creditUse)}</span></p>}
                <p className="total"><span>{t('record.lineTotal')}</span><span>{yen(price.total)}</span></p>
              </div>
            )}
          </>
        )}

        <label className="field">
          <span>{t('record.memo')}</span>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={4} />
        </label>

        <button className="primary" disabled={busy}>{busy ? t('record.sending') : t('record.submit')}</button>
      </form>

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
  const [message, setMessage] = useState('');

  if (!card.today_visits.length) return null;

  async function confirmVoid(visitId: string) {
    if (!reason.trim()) { setMessage(t('errors.void_reason_required')); return; }
    try {
      const r = await sendMutation('void_visit', { visit_id: visitId, reason }, `void ${card.customer.name}`);
      setMessage(r.queued ? t('record.queued') : t('record.voidDone'));
      setVoiding(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['patient-card', card.customer.id] });
      await qc.invalidateQueries({ queryKey: ['monthly-stats'] });
    } catch (err) {
      setMessage(errorText(t, err));
    }
  }

  return (
    <section className="card">
      <h2>{t('record.today')}</h2>
      {message && <p className="message warn">{message}</p>}
      <ul className="list">
        {card.today_visits.map((v) => {
          const m = menus.data?.find((x) => x.id === v.menu_id);
          return (
            <li key={v.id} className={v.status === 'voided' ? 'voided' : ''}>
              <span>{v.attended ? (m ? pickName(m.name, i18n.language) : '') : t('record.noShow')}</span>
              <span>{yen(v.total)}</span>
              {v.status === 'voided' ? (
                <span className="muted">{t('record.voided')}</span>
              ) : voiding === v.id ? (
                <span className="inline">
                  <input placeholder={t('record.voidReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" className="danger" onClick={() => void confirmVoid(v.id)}>{t('record.void')}</button>
                  <button type="button" onClick={() => setVoiding(null)}>×</button>
                </span>
              ) : (
                <button type="button" onClick={() => { setVoiding(v.id); setMessage(''); }}>{t('record.void')}</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
