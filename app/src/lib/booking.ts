// 予約まわりの共通処理。日時はすべて店舗のタイムゾーン(日本時間)で扱う
import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { BusinessError } from './rpc';

export const TZ = 'Asia/Tokyo';
export const STORE_ID = import.meta.env.VITE_STORE_ID as string;

/** 日本時間での YYYY-MM-DD */
export function tokyoDate(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}
export function tokyoTime(d: Date | string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
}
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
/** 日本時間のその日の [00:00, 翌00:00) を PostgREST の範囲文字列で */
export function dayRange(date: string): string {
  return `[${date}T00:00:00+09:00,${addDays(date, 1)}T00:00:00+09:00)`;
}
export function formatDate(date: string, lang: string): string {
  const loc = lang === 'ja' ? 'ja-JP' : lang === 'pt' ? 'pt-BR' : 'es';
  return new Intl.DateTimeFormat(loc, { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

export interface Slot { start_at: string; staff_ids: string[] }

/** 期間内の空き(日付ごとにまとめる) */
export const useSlots = (menuId: string | undefined, from: string, to: string) =>
  useQuery({
    queryKey: ['slots', menuId, from, to],
    enabled: !!menuId,
    staleTime: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_available_slots', { p_store: STORE_ID, p_menu: menuId, p_from: from, p_to: to });
      if (error) throw error.code === 'P0001' ? new BusinessError(error.message) : new Error(error.message);
      const byDay = new Map<string, Slot[]>();
      for (const s of (data ?? []) as Slot[]) {
        const k = tokyoDate(s.start_at);
        byDay.set(k, [...(byDay.get(k) ?? []), s]);
      }
      return byDay;
    },
  });

/** RPC を呼ぶ(通信エラーは 3 回まで再送。request_id があるので二重にならない) */
export async function callRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabase.rpc(name, args);
    if (!error) return data as T;
    if (error.code === 'P0001') throw new BusinessError(error.message);
    last = new Error(error.message);
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw last;
}
