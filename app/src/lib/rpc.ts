// 書き込み系 RPC の送信。
//  - request_id を付けて送る(DB が二重記録を防ぐので、同じ request_id での再送は安全)
//  - 通信エラーは自動で再送し、それでも届かなければ端末に保存して後で送る(送信待ち)
//  - 業務エラー(残高不足など)は再送せず、そのまま画面に返す
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

export interface PendingCall {
  name: RpcName;
  payload: Record<string, unknown> & { request_id: string };
  label: string;
  queuedAt: string;
}

const OUTBOX_KEY = 'lbc_outbox_v1';

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

function writeOutbox(items: PendingCall[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    // 保存できなくても送信自体は続ける
  }
  window.dispatchEvent(new Event('lbc-outbox'));
}

function removeFromOutbox(requestId: string) {
  writeOutbox(readOutbox().filter((c) => c.payload.request_id !== requestId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1 回送る。業務エラーは BusinessError、通信系は Error を投げる
async function sendOnce<T>(call: PendingCall): Promise<T> {
  const { data, error } = await supabase.rpc(call.name, { p: call.payload });
  if (error) {
    // raise exception ... errcode 'P0001' = 業務エラー
    if (error.code === 'P0001') throw new BusinessError(error.message);
    throw new Error(error.message || 'network_error');
  }
  return data as T;
}

/**
 * 送信する。通信エラーは最大 3 回まで自動再送し、届かなければ送信待ちに残して
 * `{ queued: true }` を返す(後で flushOutbox が送る)。
 */
export async function sendMutation<T>(
  name: RpcName,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ queued: false; data: T } | { queued: true }> {
  const call: PendingCall = {
    name,
    payload: { ...payload, request_id: (payload.request_id as string) ?? newRequestId() },
    label,
    queuedAt: new Date().toISOString(),
  };
  writeOutbox([...readOutbox(), call]);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await sendOnce<T>(call);
      removeFromOutbox(call.payload.request_id);
      return { queued: false, data };
    } catch (e) {
      if (e instanceof BusinessError) {
        removeFromOutbox(call.payload.request_id);
        throw e;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  return { queued: true };
}

let flushing = false;

/** 送信待ちを順に送る。業務エラーになったものは失敗リストとして返す */
export async function flushOutbox(): Promise<{ sent: number; failed: { call: PendingCall; error: BusinessError }[] }> {
  if (flushing) return { sent: 0, failed: [] };
  flushing = true;
  let sent = 0;
  const failed: { call: PendingCall; error: BusinessError }[] = [];
  try {
    for (const call of readOutbox()) {
      try {
        await sendOnce(call);
        removeFromOutbox(call.payload.request_id);
        sent++;
      } catch (e) {
        if (e instanceof BusinessError) {
          removeFromOutbox(call.payload.request_id);
          failed.push({ call, error: e });
        } else {
          break; // まだ通信できない。次の機会に
        }
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed };
}
