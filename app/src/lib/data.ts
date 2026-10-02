// 読み込み系。TanStack Query が自動リトライ・キャッシュする(main.tsx の設定)
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { supabase } from './supabase';
import { BusinessError } from './rpc';

export type I18nName = Record<string, string>;

export interface StaffMe { id: string; store_id: string; role: 'owner' | 'staff'; display_name: string }
export interface Customer {
  id: string; code: string; name: string; furigana: string | null; phone_normalized: string | null;
  status: 'active' | 'archived'; lang: string;
}
export interface Menu { id: string; code: string; name: I18nName; price: number; duration_min: number; sort: number }
export interface Product {
  id: string; code: string; kind: string; name: I18nName; price: number; uses: number; menu_ids: string[] | null;
}
export interface PatientCard {
  customer: { id: string; code: string; name: string; furigana: string | null; lang: string; referred_by: string | null };
  visit_count: number;
  last_visit_before_today: string | null;
  is_first_visit: boolean;
  credit_available: number;
  credit_expiring: { expires_on: string; amount: number }[];
  passes: { id: string; product_code: string; name: I18nName; remaining: number; valid_until: string; menu_ids: string[] | null }[];
  today_visits: { id: string; attended: boolean; menu_id: string | null; status: string; memo: string | null; total: number }[];
}
export interface MonthlyStats {
  store_id: string; month: string; visits: number; new_customers: number;
  sales_total: number; unpaid_total: number; avg_per_visit: number | null;
}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error.code === 'P0001' ? new BusinessError(error.message) : new Error(error.message);
  return data as T;
}

export const useMe = (userId: string | undefined) =>
  useQuery({
    queryKey: ['me', userId],
    enabled: !!userId,
    queryFn: () =>
      must<StaffMe[]>(supabase.from('staff').select('id, store_id, role, display_name')
        .eq('user_id', userId!).eq('active', true)),
  });

export const useCustomers = () =>
  useQuery({
    queryKey: ['customers'],
    queryFn: () =>
      must<Customer[]>(supabase.from('customers')
        .select('id, code, name, furigana, phone_normalized, status, lang')
        .eq('status', 'active').order('code')),
  });

export const useMenus = () =>
  useQuery({
    queryKey: ['menus'],
    staleTime: 10 * 60_000,
    queryFn: () =>
      must<Menu[]>(supabase.from('menus').select('id, code, name, price, duration_min, sort')
        .eq('active', true).order('sort')),
  });

export const useProducts = () =>
  useQuery({
    queryKey: ['products'],
    staleTime: 10 * 60_000,
    queryFn: () =>
      must<Product[]>(supabase.from('products').select('id, code, kind, name, price, uses, menu_ids')
        .eq('active', true).order('price')),
  });

export const usePatientCard = (customerId: string | undefined) =>
  useQuery({
    queryKey: ['patient-card', customerId],
    enabled: !!customerId,
    queryFn: () => must<PatientCard>(supabase.rpc('get_patient_card', { p_customer: customerId })),
  });

export const useMonthlyStats = () =>
  useQuery({
    queryKey: ['monthly-stats'],
    queryFn: () =>
      must<MonthlyStats[]>(supabase.from('v_monthly_stats').select('*').order('month', { ascending: false }).limit(12)),
  });

/** DB の業務エラーを画面の文言にする */
export function errorText(t: TFunction, e: unknown): string {
  if (e instanceof BusinessError) {
    const key = `errors.${e.code}`;
    return t(key, { detail: e.detail, defaultValue: t('errors.unknown', { code: e.code }) });
  }
  return t('errors.unknown', { code: e instanceof Error ? e.message : String(e) });
}

/** 検索用の正規化(空白除去・小文字・カタカナ→ひらがな) */
export function searchKey(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s　\-]/g, '')
    .replace(/[ァ-ン]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
