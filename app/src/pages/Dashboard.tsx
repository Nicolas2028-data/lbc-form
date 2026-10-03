import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Coins, TableProperties, TrendingDown, TrendingUp, UserPlus, Users } from 'lucide-react';
import { useMonthlyStats, errorText, type MonthlyStats } from '../lib/data';
import { yen } from '../lib/pricing';
import { Card, ErrorBox, Loading } from '../ui';

// 直近 12 か月(データのない月は 0 で埋める)
function last12(rows: MonthlyStats[]) {
  const byMonth = new Map(rows.map((r) => [r.month.slice(0, 7), r]));
  const out: { key: string; row: MonthlyStats | undefined }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
    out.push({ key, row: byMonth.get(key) });
  }
  return out;
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  const { t } = useTranslation();
  if (!prev) return <span className="tile-foot">{t('dashboard.vsLast')} —</span>;
  const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  const up = pct >= 0;
  return (
    <span className="tile-foot">
      <span className={up ? 'delta-up' : 'delta-down'}>
        {up ? <TrendingUp size={13} /> : <TrendingDown size={13} />} {up ? '+' : ''}{pct}%
      </span>{' '}{t('dashboard.vsLast')}
    </span>
  );
}

function Tile({ label, icon, value, cur, prev }: { label: string; icon: React.ReactNode; value: string; cur: number; prev: number }) {
  return (
    <div className="card tile fade-in">
      <div className="tile-head"><span>{label}</span><span className="tile-icon">{icon}</span></div>
      <div className="tile-value">{value}</div>
      <Delta cur={cur} prev={prev} />
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const stats = useMonthlyStats();
  const [hover, setHover] = useState<string | null>(null);

  if (stats.isPending) return <Loading />;
  if (stats.isError) return <ErrorBox text={errorText(t, stats.error)} onRetry={() => void stats.refetch()} />;

  const months = last12(stats.data);
  const cur = months[11].row;
  const prev = months[10].row;
  const max = Math.max(1, ...months.map((m) => m.row?.sales_total ?? 0));
  const n = (r: MonthlyStats | undefined, k: keyof MonthlyStats) => Number(r?.[k] ?? 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.subtitle')}</p>
        </div>
        <span className="badge">{months[11].key}</span>
      </div>

      <div className="tiles">
        <Tile label={t('dashboard.sales')} icon={<Coins size={18} />} value={yen(n(cur, 'sales_total'))}
              cur={n(cur, 'sales_total')} prev={n(prev, 'sales_total')} />
        <Tile label={t('dashboard.visits')} icon={<Users size={18} />} value={String(n(cur, 'visits'))}
              cur={n(cur, 'visits')} prev={n(prev, 'visits')} />
        <Tile label={t('dashboard.newCustomers')} icon={<UserPlus size={18} />} value={String(n(cur, 'new_customers'))}
              cur={n(cur, 'new_customers')} prev={n(prev, 'new_customers')} />
        <Tile label={t('dashboard.avg')} icon={<BarChart3 size={18} />} value={cur?.avg_per_visit != null ? yen(cur.avg_per_visit) : '—'}
              cur={n(cur, 'avg_per_visit')} prev={n(prev, 'avg_per_visit')} />
      </div>

      <Card title={t('dashboard.trend')} icon={<BarChart3 size={18} />} pad={false}>
        <div className="chart">
          <div className="bars" role="img" aria-label={t('dashboard.trend')} onMouseLeave={() => setHover(null)}>
            {months.map((m, i) => {
              const v = m.row?.sales_total ?? 0;
              return (
                <div key={m.key} className="bar" onMouseEnter={() => setHover(m.key)} onClick={() => setHover(m.key)}>
                  <div className="bar-fill" style={{ height: `${Math.max(0, (v / max) * 100)}%` }} />
                  {i === 11 && v > 0 && hover !== m.key && <span className="bar-value">{yen(v)}</span>}
                  {hover === m.key && (
                    <div className="bar-tip">
                      {m.key}
                      <strong>{yen(v)}</strong>
                      {t('dashboard.visits')} {m.row?.visits ?? 0}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="bar-labels">
            {months.map((m, i) => <span key={m.key} className={i === 11 ? 'current' : ''}>{Number(m.key.slice(5))}</span>)}
          </div>
        </div>
      </Card>

      <Card title={t('dashboard.table')} icon={<TableProperties size={18} />} pad={false}>
        {stats.data.length === 0 ? <div className="empty">{t('dashboard.noData')}</div> : (
          <div className="table-wrap">
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
                    <td>{yen(r.sales_total)}</td><td>{r.unpaid_total ? yen(r.unpaid_total) : '—'}</td>
                    <td>{r.avg_per_visit != null ? yen(r.avg_per_visit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
