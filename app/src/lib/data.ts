// 読み込み系。TanStack Query が自動リトライ・キャッシュする(main.tsx の設定)
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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

/** 患者検索(DB 側で検索し、一致した人を最大 limit 人返す。空なら最近の患者)。
 *  全員分を読み込まないので、患者が何千人になっても速さが変わらない */
export const useCustomerSearch = (q: string, limit = 50, enabled = true) =>
  useQuery({
    queryKey: ['customers', 'search', q.trim(), limit],
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    queryFn: () =>
      must<(Customer & { last_visit: string | null })[]>(supabase.rpc('search_customers', { p_q: q.trim(), p_limit: limit })),
  });

export const useMenus = () =>
  useQuery({
    queryKey: ['menus'],
    staleTime: 10 * 60_000,
    queryFn: () =>
      must<Menu[]>(supabase.from('menus').select('id, code, name, price, duration_min, sort')
        .eq('active', true).order('sort')),
  });

/** 履歴の表示用: 廃止したメニューも含む */
export const useAllMenus = () =>
  useQuery({
    queryKey: ['menus-all'],
    staleTime: 10 * 60_000,
    queryFn: () =>
      must<Menu[]>(supabase.from('menus').select('id, code, name, price, duration_min, sort').order('sort')),
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
    queryFn: () => must<MonthlyStats[]>(supabase.rpc('get_monthly_stats', { p_months: 12 })),
  });

/** DB の業務エラーを画面の文言にする */
export function errorText(t: TFunction, e: unknown): string {
  if (e instanceof BusinessError) {
    const key = `errors.${e.code}`;
    return t(key, { detail: e.detail, defaultValue: t('errors.unknown', { code: e.code }) });
  }
  return t('errors.unknown', { code: e instanceof Error ? e.message : String(e) });
}


// ── 顧客詳細 ──
export interface CustomerFull extends Customer {
  email: string | null; birth_date: string | null; address: string | null; notes: string | null;
  how_found: string[]; first_visit_date: string | null; referred_by: string | null; created_at: string;
}
export interface VisitRow {
  id: string; visit_date: string; attended: boolean; status: 'recorded' | 'voided'; memo: string | null;
  no_show_reason: string | null; change_from_last: 'none' | 'changed' | null; menu_id: string | null;
  void_reason: string | null; created_at: string; sales: { amount: number; method: string; kind: string }[];
}
export interface CreditRow {
  id: string; kind: 'grant' | 'use' | 'expire' | 'void'; amount: number; reason: string | null;
  expires_on: string | null; occurred_on: string; created_at: string;
}

export const useCustomer = (id: string | undefined) =>
  useQuery({
    queryKey: ['customer', id],
    enabled: !!id,
    queryFn: () =>
      must<CustomerFull>(supabase.from('customers')
        .select('id, code, name, furigana, phone_normalized, status, lang, email, birth_date, address, notes, how_found, first_visit_date, referred_by, created_at')
        .eq('id', id!).single()),
  });

export const useVisitHistory = (id: string | undefined) =>
  useQuery({
    queryKey: ['visits', id],
    enabled: !!id,
    queryFn: () =>
      must<VisitRow[]>(supabase.from('visits')
        .select('id, visit_date, attended, status, memo, no_show_reason, change_from_last, menu_id, void_reason, created_at, sales(amount, method, kind)')
        .eq('customer_id', id!).order('visit_date', { ascending: false }).order('created_at', { ascending: false }).limit(200)),
  });

export const useCreditHistory = (id: string | undefined) =>
  useQuery({
    queryKey: ['credits', id],
    enabled: !!id,
    queryFn: () =>
      must<CreditRow[]>(supabase.from('credit_entries')
        .select('id, kind, amount, reason, expires_on, occurred_on, created_at')
        .eq('customer_id', id!).order('created_at', { ascending: false }).limit(200)),
  });

export type CustomerPatch = Partial<Pick<CustomerFull,
  'name' | 'furigana' | 'phone_normalized' | 'email' | 'birth_date' | 'address' | 'notes' | 'lang' | 'status'>>;

export async function updateCustomer(id: string, patch: CustomerPatch): Promise<void> {
  await must(supabase.from('customers').update(patch).eq('id', id).select('id'));
}

// ── 問診 ──
export interface QuestionnaireRow {
  id: string; submitted_at: string; lang: string; answers: Record<string, unknown>; matched_existing: boolean;
  image_paths: { body?: string; signature?: string };
}

export const useQuestionnaires = (customerId: string | undefined) =>
  useQuery({
    queryKey: ['questionnaires', customerId],
    enabled: !!customerId,
    queryFn: () =>
      must<QuestionnaireRow[]>(supabase.from('questionnaires')
        .select('id, submitted_at, lang, answers, image_paths, matched_existing')
        .eq('customer_id', customerId!).order('submitted_at', { ascending: false }).limit(20)),
  });

/** 非公開の画像を一時的に見るための URL(10 分有効) */
export const useSignedImage = (path: string | undefined) =>
  useQuery({
    queryKey: ['signed', path],
    enabled: !!path,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('questionnaire').createSignedUrl(path!, 600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
  });
