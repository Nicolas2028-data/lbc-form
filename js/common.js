/* ============================================================
   js/common.js — LBC Care 共通ユーティリティ
   questionnaire.html / treatment-record.html から読み込む
   ============================================================ */

// ── GAS fetch wrapper ──
async function gasPost(url, body, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  const ctrl = new AbortController();
  const tid = setTimeout(function() { ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    return await res.json();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ── UUID / requestId ──
function genRequestId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getOrCreateRequestId(storageKey) {
  var rid = localStorage.getItem(storageKey);
  if (!rid) { rid = genRequestId(); localStorage.setItem(storageKey, rid); }
  return rid;
}

// ── Phone validation patterns (per language) ──
var PHONE_PATTERNS = {
  ja: /^0\d{9,10}$/,
  es: /^\+?[\d\s\-().]{7,20}$/,
  pt: /^\+?[\d\s\-().]{7,20}$/,
};
