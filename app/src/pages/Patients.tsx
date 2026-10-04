import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight, IdCard, Search, UserX } from 'lucide-react';
import { useCustomerSearch, errorText } from '../lib/data';
import { Avatar, ErrorBox, Loading } from '../ui';

export default function Patients() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const deferred = useDeferredValue(q);
  const customers = useCustomerSearch(deferred, 100);
  const hits = customers.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('patients.title')}</h1>
          <p>{t('patients.subtitle')}</p>
        </div>
        {customers.data && <span className="badge">{t('patients.count', { count: hits.length })}</span>}
      </div>

      <label className="search">
        <Search size={20} />
        <input type="search" autoFocus placeholder={t('patients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      {customers.isPending && <Loading />}
      {customers.isError && <ErrorBox text={errorText(t, customers.error)} onRetry={() => void customers.refetch()} />}
      {customers.data && (
        <section className="card fade-in">
          {hits.length === 0 ? (
            <div className="empty"><UserX size={28} /><span>{t('patients.none')}</span></div>
          ) : (
            <ul className="list">
              {hits.map((c) => (
                <li key={c.id} style={{ display: 'flex', alignItems: 'center' }}>
                  <Link to={`/staff/record/${c.id}`} className="list-item" style={{ flex: 1 }}>
                    <Avatar name={c.name} seed={c.id} />
                    <div className="list-main">
                      <div className="list-title">{c.name}</div>
                      <div className="list-sub">{c.furigana ?? '—'}</div>
                    </div>
                    <span className="badge mono">{c.code}</span>
                    <ChevronRight size={18} className="chev" />
                  </Link>
                  <Link to={`/staff/customers/${c.id}`} className="btn btn-ghost btn-sm" title={t('patients.detail')}
                        style={{ marginRight: 8, textDecoration: 'none' }}>
                    <IdCard size={18} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
