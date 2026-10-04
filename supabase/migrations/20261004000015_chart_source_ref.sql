-- 移行元の印(Notion のページ ID など)。同じものを二度取り込まないように一意にする(2026-10-04)
alter table public.chart_notes add column source_ref text unique;
alter table public.chart_photos add column source_ref text unique;
grant insert (source_ref) on public.chart_notes to authenticated;
grant insert (source_ref) on public.chart_photos to authenticated;
