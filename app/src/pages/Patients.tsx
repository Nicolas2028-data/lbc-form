import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCustomers, errorText, searchKey } from '../lib/data';

export default function Patients() {
  const { t } = useTranslation();
  const customers = useCustomers();
  const [q, setQ] = useState('');

  const hits = useMemo(() => {
    const list = customers.data ?? [];
    const k = searchKey(q);
    if (!k) return list;
    return list.filter((c) =>
      [c.name, c.furigana, c.code, c.phone_normalized].some((v) => searchKey(v).includes(k)));
  }, [customers.data, q]);

  return (
    <>
      <input className="search" type="search" autoFocus placeholder={t('patients.search')}
             value={q} onChange={(e) => setQ(e.target.value)} />
      {customers.isPending && <p>{t('app.loading')}</p>}
      {customers.isError && (
        <p className="error">
          {errorText(t, customers.error)} <button onClick={() => void customers.refetch()}>{t('app.retry')}</button>
        </p>
      )}
      {customers.data && (
        <>
          <p className="muted">{t('patients.count', { count: hits.length })}</p>
          {hits.length === 0 && <p>{t('patients.none')}</p>}
          <ul className="list">
            {hits.map((c) => (
              <li key={c.id}>
                <Link to={`/staff/record/${c.id}`}>
                  <span className="name">{c.name}</span>
                  {c.furigana && <span className="muted"> {c.furigana}</span>}
                  <span className="code">{c.code}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
