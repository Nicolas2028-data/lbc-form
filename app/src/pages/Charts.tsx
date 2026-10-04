// カルテ一覧(Notion の施術カルテ DB のビューの置き換え): 期間とキーワードで過去のカルテを探す
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Camera, FileSearch, NotebookPen, Search } from 'lucide-react';
import { useVisitList } from '../lib/chart';
import { tokyoDate } from '../lib/booking';
import { errorText, useAllMenus } from '../lib/data';
import { yen } from '../lib/pricing';
import { pickName } from '../i18n';
import { ErrorBox, Loading } from '../ui';

type Range = 'month' | 'last' | '3m' | 'year';
function rangeOf(r: Range): [string, string] {
  const today = tokyoDate(new Date());
  const [y, m] = today.split('-').map(Number);
  const first = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  if (r === 'month') return [first(y, m), today];
  if (r === 'last') return [first(y, m - 1), last(y, m - 1)];
  if (r === '3m') return [first(y, m - 2), today];
  return [first(y, m - 11), today];
}

export default function Charts() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>('3m');
  const [q, setQ] = useState('');
  const deferred = useDeferredValue(q);
  const [from, to] = rangeOf(range);
  const list = useVisitList(from, to, deferred);
  const menus = useAllMenus();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('charts.title')}</h1>
          <p>{t('charts.subtitle')}</p>
        </div>
        {list.data && <span className="badge">{t('charts.count', { count: list.data.length })}</span>}
      </div>

      <label className="search">
        <Search size={20} />
        <input type="search" placeholder={t('charts.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="segmented" style={{ justifySelf: 'start' }}>
        {(['month', 'last', '3m', 'year'] as Range[]).map((r) => (
          <button key={r} type="button" className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{t(`charts.range_${r}`)}</button>
        ))}
      </div>

      {list.isPending && <Loading />}
      {list.isError && <ErrorBox text={errorText(t, list.error)} onRetry={() => void list.refetch()} />}
      {list.data && (
        <section className="card fade-in">
          {list.data.length === 0 ? (
            <div className="empty"><FileSearch size={28} /><span>{t('charts.none')}</span></div>
          ) : (
            <ul className="list">
              {list.data.map((v) => {
                const m = menus.data?.find((x) => x.id === v.menu_id);
                return (
                  <li key={v.id}>
                    <Link to={`/staff/customers/${v.customer_id}#v-${v.id}`} className={`list-item chart-row ${v.status === 'voided' ? 'voided' : ''}`}>
                      <span className="tl-date">{v.visit_date.slice(5).replace('-', '/')}</span>
                      <div className="list-main">
                        <div className="list-title inline" style={{ gap: 8 }}>
                          <span>{v.customer_name}</span>
                          <span className="badge mono">{v.customer_code}</span>
                        </div>
                        <div className="list-sub inline" style={{ gap: 6 }}>
                          <span>{v.attended ? (m ? pickName(m.name, i18n.language) : '—') : t('customer.noShow')}</span>
                          {v.days_since_prev !== null && <span>· {t('charts.sincePrev', { days: v.days_since_prev })}</span>}
                          {v.notes > 0 && <span className="inline" style={{ gap: 2 }}><NotebookPen size={13} />{v.notes}</span>}
                          {v.photos > 0 && <span className="inline" style={{ gap: 2 }}><Camera size={13} />{v.photos}</span>}
                        </div>
                        {(v.note_excerpt || v.memo) && <div className="chart-excerpt">{v.note_excerpt || v.memo}</div>}
                      </div>
                      <div className="day-badges">
                        {v.change_from_last === 'changed' && <span className="badge badge-warn">{t('customer.changed')}</span>}
                        {v.unpaid && <span className="badge badge-danger">{t('record.unpaid')}</span>}
                        {v.status === 'voided' && <span className="badge badge-danger">{t('record.voided')}</span>}
                        <span className="tl-amount">{yen(v.total)}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
