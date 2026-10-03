// 書き込み系 RPC の送信と「送信待ち」(オフライン対策)
//  - request_id を付けて送る(DB が二重記録を防ぐので、同じ request_id での再送は安全)
//  - 通信エラーは自動で再送し、それでも届かなければ端末に保存して後で送る
//  - 業務エラー(残高不足など)になった送信待ちは消さずに「送信失敗」として残し、
//    スタッフが内容を見て再送・破棄を選ぶ(記録が黙って消えないように)
//  - 送信中のものは自動再送の対象から外す(同じ記録を並行して送らない)
import { supabase } from './supabase';

export type RpcName = 'record_visit' | 'void_visit';

export class BusinessError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(message: string) {
    super(message);
    const [code, detail] = message.split(':');
    this.code = code;
    this.detail = detail;
  }
}

/** 通信が届かなかった(サーバーが応答していない)エラー */
export class NetworkError extends Error {}

export interface PendingCall {
  name: RpcName;
  payload: Record<string, unknown> & { request_id: string };
  label: string;
  queuedAt: string;
  userId: string | null;          // 記録したスタッフ。別のスタッフのログイン中には送らない
  status: 'pending' | 'failed';
  attempts: number;
  lastError?: string;             // 業務エラーのコード、またはサーバーのエラー
}

const OUTBOX_KEY = 'lbc_outbox_v2';
const MAX_SERVER_ERRORS = 5;      // 通信以外のエラーがこの回数続いたら「送信失敗」に
const inflight = new Set<string>();

export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function readOutbox(): PendingCall[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as PendingCall[];
  } catch {
    return [];
  }
}

function writeOutbox(items: PendingCall[]): boolean {
  let ok = true;
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    ok = false;
  }
  window.dispatchEvent(new Event('lbc-outbox'));
  return ok;
}

function updateItem(requestId: string, fn: (c: PendingCall) => PendingCall | null) {
  const next: PendingCall[] = [];
  for (const c of readOutbox()) {
    if (c.payload.request_id !== requestId) { next.push(c); continue; }
    const r = fn(c);
    if (r) next.push(r);
  }
  writeOutbox(next);
}

export const discardPending = (requestId: string) => updateItem(requestId, () => null);
export const retryPending = (requestId: string) =>
  updateItem(requestId, (c) => ({ ...c, status: 'pending', attempts: 0, lastError: undefined }));

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1 回送る。業務エラーは BusinessError、通信できなければ NetworkError、それ以外は Error
async function sendOnce<T>(name: RpcName, payload: Record<string, unknown>): Promise<T> {
  let res;
  try {
    res = await supabase.rpc(name, { p: payload });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  const { data, error } = res;
  if (error) {
    if (error.code === 'P0001') throw new BusinessError(error.message);
    // PostgREST / Postgres のエラーにはコードが付く。付いていなければ通信の失敗
    if (!error.code) throw new NetworkError(error.message || 'network_error');
    throw new Error(`${error.code}: ${error.message}`);
  }
  return data as T;
}

/**
 * 送信する。通信エラーは最大 3 回まで自動再送し、届かなければ送信待ちに残して
 * `{ queued: true }` を返す(後で flushOutbox が送る)。業務エラーはそのまま投げる。
 */
export async function sendMutation<T>(
  name: RpcName,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ queued: false; data: T } | { queued: true }> {
  const requestId = (payload.request_id as string) ?? newRequestId();
  const call: PendingCall = {
    name, payload: { ...payload, request_id: requestId }, label, queuedAt: new Date().toISOString(),
    userId: await currentUserId(), status: 'pending', attempts: 0,
  };
  inflight.add(requestId);
  // 送信中に画面が閉じても失われないよう、先に保存しておく(送信中は自動再送の対象外)
  const saved = writeOutbox([...readOutbox().filter((c) => c.payload.request_id !== requestId), call]);
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await sendOnce<T>(name, call.payload);
        discardPending(requestId);
        return { queued: false, data };
      } catch (e) {
        if (e instanceof BusinessError) {
          discardPending(requestId);   // 画面にエラーを出して、スタッフがその場で直す
          throw e;
        }
        lastErr = e;
        await sleep(500 * 2 ** attempt);
      }
    }
    if (!saved) throw lastErr;          // 端末に保存できなかった → 送信待ちにせずエラーを見せる
    return { queued: true };
  } finally {
    inflight.delete(requestId);
  }
}

let flushing = false;

/** 送信待ちを順に送る。送れたら消し、業務エラーは「送信失敗」として残す */
export async function flushOutbox(): Promise<{ sent: number; failed: number }> {
  if (flushing) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    const me = await currentUserId();
    for (const call of readOutbox()) {
      const id = call.payload.request_id;
      if (call.status !== 'pending' || inflight.has(id) || call.userId !== me) continue;
      inflight.add(id);
      try {
        await sendOnce(call.name, call.payload);
        discardPending(id);
        sent++;
      } catch (e) {
        if (e instanceof NetworkError) break;   // まだ通信できない。次の機会に
        const isBusiness = e instanceof BusinessError;
        updateItem(id, (c) => {
          const attempts = c.attempts + 1;
          const giveUp = isBusiness || attempts >= MAX_SERVER_ERRORS;
          if (giveUp) failed++;
          return { ...c, attempts, status: giveUp ? 'failed' : 'pending', lastError: e instanceof Error ? e.message : String(e) };
        });
      } finally {
        inflight.delete(id);
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed };
}
