// ホーム: 上は立体アニメーション(直近 12 か月の売上)、下は公式サイトのようなカテゴリと今月の数字
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BarChart3, CalendarCheck, ChevronDown, ClipboardList, FileText, Leaf, ShieldCheck, Users,
} from 'lucide-react';
import { useMonthlyStats, type MonthlyStats } from '../lib/data';
import { useDay } from '../lib/chart';
import { yen } from '../lib/pricing';
import { useOpenKiosk, useStaff } from './StaffLayout';

const HeroScene = lazy(() => import('../components/HeroScene'));

function last12(rows: MonthlyStats[]) {
  const byMonth = new Map(rows.map((r) => [r.month.slice(0, 7), r]));
  const d = new Date();
  return Array.from({ length: 12 }, (_, k) => {
    const x = new Date(d.getFullYear(), d.getMonth() - (11 - k), 1);
    const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
    return { key, row: byMonth.get(key) };
  });
}

export default function Home() {
  const { t, i18n } = useTranslation();
  const staff = useStaff();
  const stats = useMonthlyStats();
  const day = useDay(null);
  const openKiosk = useOpenKiosk();
  const months = last12(stats.data ?? []);
  const cur = months[11].row;
  const waiting = day.data?.items.filter((i) => i.state === 'waiting').length ?? 0;
  const done = day.data?.items.filter((i) => i.state === 'done').length ?? 0;
  const locale = i18n.language === 'ja' ? 'ja-JP' : i18n.language === 'pt' ? 'pt-BR' : 'es-ES';
  const today = new Date().toLocaleDateString(locale, { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

  const categories = [
    { to: '/staff/today', icon: CalendarCheck, title: t('nav.today'), desc: t('home.cat_today'), badge: waiting ? t('home.waitingBadge', { count: waiting }) : null },
    { to: '/staff/patients', icon: Users, title: t('nav.patients'), desc: t('home.cat_patients') },
    { to: '/staff/charts', icon: FileText, title: t('nav.charts'), desc: t('home.cat_charts') },
    { to: '/staff/dashboard', icon: BarChart3, title: t('nav.dashboard'), desc: t('home.cat_dashboard') },
  ];

  return (
    <div className="home">
      <section className="home-hero">
        {stats.data && (
          <Suspense fallback={null}>
            <HeroScene values={months.map((m) => m.row?.sales_total ?? 0)} />
          </Suspense>
        )}
        <div className="home-hero-glow" aria-hidden />
        <div className="home-hero-inner">
          <span className="home-eyebrow"><Leaf size={14} />LBC Care · {today}</span>
          <h1>{t('home.greeting', { name: staff.display_name })}</h1>
          <p>{waiting > 0 ? t('home.leadWaiting', { count: waiting }) : t('home.lead', { count: done })}</p>
          <div className="home-cta">
            <Link to="/staff/today" className="btn btn-primary btn-lg" style={{ textDecoration: 'none' }}>
              <CalendarCheck size={18} />{t('home.ctaToday')}<ArrowRight size={16} />
            </Link>
            <button type="button" className="btn-lg home-ghost" onClick={openKiosk}><ClipboardList size={18} />{t('kiosk.open')}</button>
          </div>
          <div className="home-legend">
            <span className="home-legend-dot" />{t('home.legend')}
            {cur && <strong>{t('home.thisMonth')} {yen(cur.sales_total)}</strong>}
          </div>
        </div>
        <a href="#home-menu" className="home-scroll" aria-label={t('home.scroll')}><ChevronDown size={20} /></a>
      </section>

      <section id="home-menu" className="home-section">
        <div className="home-section-head">
          <span className="home-kicker">MENU</span>
          <h2>{t('home.menuTitle')}</h2>
          <p>{t('home.menuLead')}</p>
        </div>
        <div className="home-cats">
          {categories.map(({ to, icon: Icon, title, desc, badge }) => (
            <Link key={to} to={to} className="home-cat card">
              <span className="home-cat-icon"><Icon size={22} /></span>
              <span className="home-cat-title">{title}{badge && <span className="badge badge-danger">{badge}</span>}</span>
              <span className="home-cat-desc">{desc}</span>
              <span className="home-cat-more">{t('home.open')}<ArrowRight size={14} /></span>
            </Link>
          ))}
          <button type="button" className="home-cat card" onClick={openKiosk}>
            <span className="home-cat-icon"><ClipboardList size={22} /></span>
            <span className="home-cat-title">{t('kiosk.open')}</span>
            <span className="home-cat-desc">{t('home.cat_kiosk')}</span>
            <span className="home-cat-more">{t('home.open')}<ArrowRight size={14} /></span>
          </button>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <span className="home-kicker">THIS MONTH</span>
          <h2>{t('home.numbersTitle')}</h2>
        </div>
        <div className="home-numbers">
          <div><span>{t('dashboard.visits')}</span><strong>{cur?.visits ?? 0}</strong></div>
          <div><span>{t('dashboard.newCustomers')}</span><strong>{cur?.new_customers ?? 0}</strong></div>
          <div><span>{t('dashboard.sales')}</span><strong>{yen(cur?.sales_total ?? 0)}</strong></div>
          <div><span>{t('dashboard.unpaid')}</span><strong>{yen(cur?.unpaid_total ?? 0)}</strong></div>
        </div>
      </section>

      <footer className="home-footer">
        <span className="inline"><Leaf size={16} />LBC Care</span>
        <span className="inline small"><ShieldCheck size={14} />{t('home.footerSecurity')}</span>
      </footer>
    </div>
  );
}
