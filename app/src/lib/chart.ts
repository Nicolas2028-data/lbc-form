// カルテ(Notion の置き換え): 受付・今日の一覧・カルテ一覧・カルテメモ・写真
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { BusinessError, newRequestId } from './rpc';

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error.code === 'P0001' ? new BusinessError(error.message) : new Error(error.message);
  return data as T;
}

// ── 今日の一覧・受付 ──
export type DayState = 'waiting' | 'done' | 'no_show' | 'voided';
export interface DayItem {
  checkin_id: string | null;
  source: 'staff' | 'questionnaire' | null;
  at: string;
  change_from_last: 'none' | 'changed' | null;
  state: DayState;
  customer: { id: string; code: string; name: string; furigana: string | null; lang: string };
  is_first: boolean;
  visit: { id: string; menu_id: string | null; attended: boolean; status: string; total: number; unpaid: boolean } | null;
  notes: number;
  photos: number;
}
export interface Day { date: string; today: string; items: DayItem[] }

export const useDay = (date: string | null) =>
  useQuery({
    queryKey: ['day', date],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,   // 問診票からの受付を自動で拾う
    queryFn: () => must<Day>(supabase.rpc('get_day', { p_date: date })),
  });

export const checkin = (customerId: string, secondVisit = false) =>
  must<{ id: string; existing: boolean }>(supabase.rpc('checkin', { p: { customer_id: customerId, second_visit: secondVisit } }));

/** 受付の「前回から変化」を変える(null で外す) */
export const setCheckinChange = (checkinId: string, change: 'none' | 'changed' | null) =>
  must(supabase.rpc('checkin', { p: { checkin_id: checkinId, change_from_last: change } }));

export const cancelCheckin = (checkinId: string) =>
  must(supabase.rpc('cancel_checkin', { p: { checkin_id: checkinId } }));

// ── カルテ一覧 ──
export interface VisitListRow {
  id: string; visit_date: string; customer_id: string; customer_code: string; customer_name: string;
  menu_id: string | null; attended: boolean; status: 'recorded' | 'voided'; change_from_last: 'none' | 'changed' | null;
  total: number; unpaid: boolean; memo: string | null; note_excerpt: string | null; notes: number; photos: number;
  days_since_prev: number | null;
}

export const useVisitList = (from: string, to: string, q: string) =>
  useQuery({
    queryKey: ['visit-list', from, to, q.trim()],
    placeholderData: keepPreviousData,
    queryFn: () => must<VisitListRow[]>(supabase.rpc('list_visits', { p_from: from, p_to: to, p_q: q.trim(), p_limit: 300 })),
  });

// ── カルテメモ ──
export interface ChartNote {
  id: string; customer_id: string; visit_id: string | null; body: string; pinned: boolean;
  created_at: string; updated_at: string; created_by: string | null; updated_by: string | null;
}

export const useChartNotes = (customerId: string | undefined) =>
  useQuery({
    queryKey: ['chart-notes', customerId],
    enabled: !!customerId,
    queryFn: () =>
      must<ChartNote[]>(supabase.from('chart_notes')
        .select('id, customer_id, visit_id, body, pinned, created_at, updated_at, created_by, updated_by')
        .eq('customer_id', customerId!).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(500)),
  });

export const addNote = (n: { store_id: string; customer_id: string; visit_id: string | null; body: string; pinned?: boolean }) =>
  must(supabase.from('chart_notes').insert({ ...n, pinned: n.pinned ?? false }).select('id'));

export const updateNote = (id: string, patch: { body?: string; pinned?: boolean }) =>
  must(supabase.from('chart_notes').update(patch).eq('id', id).select('id'));

export const deleteNote = (id: string) =>
  must(supabase.from('chart_notes').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id'));

/** スタッフ名(誰が書いたか表示する) */
export const useStaffNames = () =>
  useQuery({
    queryKey: ['staff-names'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const rows = await must<{ id: string; display_name: string }[]>(supabase.from('staff').select('id, display_name'));
      return new Map(rows.map((r) => [r.id, r.display_name]));
    },
  });

// ── 写真 ──
export interface ChartPhoto {
  id: string; customer_id: string; visit_id: string | null; path: string; caption: string | null; created_at: string;
}

export const useChartPhotos = (customerId: string | undefined) =>
  useQuery({
    queryKey: ['chart-photos', customerId],
    enabled: !!customerId,
    queryFn: () =>
      must<ChartPhoto[]>(supabase.from('chart_photos')
        .select('id, customer_id, visit_id, path, caption, created_at')
        .eq('customer_id', customerId!).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(500)),
  });

export const useChartImage = (path: string | undefined) =>
  useQuery({
    queryKey: ['chart-image', path],
    enabled: !!path,
    staleTime: 8 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('chart').createSignedUrl(path!, 600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
  });

/** 写真を縮小して JPEG にする(長辺 1600px)。iPad の写真(数 MB)でも数百 KB になる */
export async function shrinkImage(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image_unreadable'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('image_unreadable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image_unreadable'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadPhoto(p: { store_id: string; customer_id: string; visit_id: string | null; file: File; caption?: string }) {
  const id = newRequestId();   // crypto.randomUUID は http(LAN の IP)では使えない
  const path = `${p.store_id}/${p.customer_id}/${id}.jpg`;
  const blob = await shrinkImage(p.file);
  const { error } = await supabase.storage.from('chart').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(error.message);
  await must(supabase.from('chart_photos').insert({
    id, store_id: p.store_id, customer_id: p.customer_id, visit_id: p.visit_id, path, caption: p.caption || null,
  }).select('id'));
}

export const deletePhoto = (id: string) =>
  must(supabase.from('chart_photos').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id'));

// ── 書きかけのメモを端末に残す(通信が切れても消えないように) ──
const draftKey = (k: string) => `lbc_draft:${k}`;
export const readDraft = (k: string) => { try { return localStorage.getItem(draftKey(k)) ?? ''; } catch { return ''; } };
/** ログアウト時: 書きかけ(患者のメモ)を端末に残さない */
export const clearDrafts = () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith('lbc_draft:')).forEach((k) => localStorage.removeItem(k)); } catch { /* 保存できない環境 */ }
};
export const saveDraft = (k: string, v: string) => {
  try { if (v) localStorage.setItem(draftKey(k), v); else localStorage.removeItem(draftKey(k)); } catch { /* 保存できない環境 */ }
};
