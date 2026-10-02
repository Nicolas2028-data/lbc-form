import { useTranslation } from 'react-i18next';
import { useMonthlyStats, errorText } from '../lib/data';
import { yen } from '../lib/pricing';

export default function Dashboard() {
  const { t } = useTranslation();
  const stats = useMonthlyStats();

  if (stats.isPending) return <p>{t('app.loading')}</p>;
  if (stats.isError) {
    return <p className="error">{errorText(t, stats.error)} <button onClick={() => void stats.refetch()}>{t('app.retry')}</button></p>;
  }
  const [cur] = stats.data;

  return (
    <>
      <h1>{t('dashboard.title')}</h1>
      {cur && (
        <div className="tiles">
          <div className="tile"><span>{t('dashboard.visits')}</span><strong>{cur.visits}</strong></div>
          <div className="tile"><span>{t('dashboard.sales')}</span><strong>{yen(cur.sales_total)}</strong></div>
          <div className="tile"><span>{t('dashboard.newCustomers')}</span><strong>{cur.new_customers}</strong></div>
          <div className="tile"><span>{t('dashboard.avg')}</span><strong>{cur.avg_per_visit != null ? yen(cur.avg_per_visit) : '—'}</strong></div>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>{t('dashboard.month')}</th><th>{t('dashboard.visits')}</th><th>{t('dashboard.newCustomers')}</th>
            <th>{t('dashboard.sales')}</th><th>{t('dashboard.unpaid')}</th><th>{t('dashboard.avg')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.data.map((r) => (
            <tr key={`${r.store_id}:${r.month}`}>
              <td>{r.month.slice(0, 7)}</td><td>{r.visits}</td><td>{r.new_customers}</td>
              <td>{yen(r.sales_total)}</td><td>{yen(r.unpaid_total)}</td>
              <td>{r.avg_per_visit != null ? yen(r.avg_per_visit) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
