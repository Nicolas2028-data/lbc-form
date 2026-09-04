/* ============================================================
   LBC Care — Google Apps Script バックエンド
   ============================================================
   【スクリプトプロパティ】
   NOTION_TOKEN              : Notion API トークン
   CUSTOMER_DB_ID            : 本番 顧客マスタ Notion DB ID
   KARTE_DB_ID               : 本番 施術カルテ Notion DB ID
   LEDGER_SPREADSHEET_ID     : 本番 台帳スプレッドシート ID
   DRIVE_FOLDER_ID           : 人体図保存 Drive フォルダ ID
   STAFF_PASSWORD            : スタッフ認証パスワード
   SITE_URL                  : フォーム公開URL
   NOTIFY_EMAIL              : エラー通知先メール
   ENV                       : production / staging
   STAGING_CUSTOMER_DB_ID    : ステージング 顧客マスタ Notion DB ID
   STAGING_KARTE_DB_ID       : ステージング 施術カルテ Notion DB ID
   STAGING_LEDGER_SPREADSHEET_ID : ステージング 台帳 ID
   ============================================================ */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

/* ── 台帳タブ列インデックス (0-based, 列A=0) ── */
const CM = { // 顧客マスタ
  customer_id:0, name:1, furigana:2, phone:3, email:4, dob:5,
  first_visit:6, lang:7, how_found:8, address:9, status:10,
  notion_page_id:11, created_at:12, updated_at:13, synced_at:14,
};
const TR = { // 施術台帳
  entry_id:0, type:1, target_entry_id:2, date:3, customer_id:4,
  course:5, sales:6, payment:7, memo:8, has_questionnaire:9,
  credit_used:10, referrer_customer_id:11, count_eligible:12,
  notion_page_id:13, created_at:14, updated_at:15, synced_at:16,
  error_count:17,
};
const QU = { // 問診台帳
  entry_id:0, date:1, customer_id:2, visit_type:3, has_changes:4,
  main_symptom:5, duration:6, pain_level:7, safety_check:8,
  safety_note:9, goal:10, strength:11, disliked:12,
  photo_consent:13, face_pref:14, consent_agreed:15,
  consent_date:16, body_image_url:17, sig_url:18,
  notion_page_id:19, created_at:20, synced_at:21, error_count:22,
  raw_json:23, // full payload (without image data) for block building
};
const CR = { // クレジット台帳
  entry_id:0, date:1, customer_id:2, type:3, amount:4,
  expiry:5, rel_entry_id:6, created_at:7, synced_at:8, error_count:9,
};
const AL = { // アクセスログ
  timestamp:0, action:1, request_id:2, result:3, error_msg:4,
  elapsed_ms:5, customer_id_hint:6,
};

/* ============================================================
   エントリポイント
   ============================================================ */

function doPost(e) {
  var t0 = Date.now();
  var action = '?';
  try {
    var data   = JSON.parse(e.postData.contents);
    action     = data.action || '?';
    var cfg    = getConfig(resolveEnv(data.env));
    if (action === 'verifyStaff')           return jsonRes(handleVerifyStaff(data, cfg));
    if (action === 'lookupPatient')         return jsonRes(handleLookupPatient(data, cfg));
    if (action === 'updateCustomerInfo')    return jsonRes(handleUpdateCustomerInfo(data, cfg));
    if (action === 'submitAll')             return jsonRes(handleSubmitAll(data, cfg));
    if (action === 'submitQuestionnaire')   return jsonRes(handleSubmitQuestionnaire(data, cfg));
    if (action === 'submitTreatmentRecord') return jsonRes(handleSubmitTreatmentRecord(data, cfg));
    if (action === 'submitBooking')         return jsonRes(handleSubmitBooking(data, cfg));
    if (action === 'getPatientList') {
      var authLP = verifyStaffPassword(data.password, cfg);
      if (!authLP.ok) return jsonRes({ success: false, error: authLP.error, remainingSec: authLP.remainingSec });
      return jsonRes(handleGetPatientList(cfg));
    }
    if (action === 'getPatientDetails') {
      var authDP = verifyStaffPassword(data.password, cfg);
      if (!authDP.ok) return jsonRes({ success: false, error: authDP.error, remainingSec: authDP.remainingSec });
      return jsonRes(handleGetPatientDetails(data.customerId, cfg));
    }
    if (action === 'submitVoidRecord') {
      var authVR = verifyStaffPassword(data.password, cfg);
      if (!authVR.ok) return jsonRes({ success: false, error: authVR.error, remainingSec: authVR.remainingSec });
      return jsonRes(handleSubmitVoidRecord(data, cfg));
    }
    return jsonRes({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    Logger.log('doPost error [' + action + ']: ' + err.message + '\n' + err.stack);
    notifyError(action, err);
    return jsonRes({ success: false, error: err.message });
  }
}

function doGet(e) {
  try {
    var p   = e.parameter;
    var cfg = getConfig(resolveEnv(p.env));

    if (p.action === 'getSlots')          return jsonRes(getMonthSlots(p.month, cfg));
    if (p.action === 'verifyStaff')       return jsonRes(handleVerifyStaff(p, cfg));
    if (p.action === 'runDiagnose'        && p.pw === cfg.STAFF_PASSWORD) return jsonRes({ report: diagnoseSyncIssues() });
    if (p.action === 'runResetSyncErrors' && p.pw === cfg.STAFF_PASSWORD) return jsonRes({ reset: resetSyncErrors() });
    if (p.action === 'runDetailedReport'  && p.pw === cfg.STAFF_PASSWORD) return jsonRes(getDetailedReport(p.date || null));
    if (p.action === 'devResetAuthLock' && cfg._env === 'staging') {
      PropertiesService.getScriptProperties().deleteProperty('bf_staff_staging');
      return jsonRes({ cleared: true });
    }
    if (p.action === 'devFixPhones' && cfg._env === 'staging') {
      fixExistingPhones(cfg);
      return jsonRes({ done: true });
    }
    if (p.action === 'devCheckTriggers' && cfg._env === 'staging') {
      var triggers = ScriptApp.getProjectTriggers().map(function(t) {
        return { fn: t.getHandlerFunction(), type: t.getEventType() + '' };
      });
      return jsonRes({ triggers: triggers });
    }
    if (p.action === 'devInstallTriggers' && cfg._env === 'staging') {
      installTriggers();
      return jsonRes({ done: true });
    }
    if (p.action === 'devSetStagingPw' && cfg._env === 'staging') {
      var newPw = String(p.pw || '');
      if (newPw.length < 4) return jsonRes({ ok: false, error: 'pw too short' });
      PropertiesService.getScriptProperties().setProperty('STAFF_PASSWORD', newPw);
      return jsonRes({ ok: true });
    }
    if (p.action === 'devSetProductionDbIds' && cfg._env === 'staging') {
      var cId = String(p.customerDbId || '');
      var kId = String(p.karteDbId || '');
      if (!cId || !kId) return jsonRes({ ok: false, error: 'customerDbId and karteDbId required' });
      PropertiesService.getScriptProperties().setProperties({ CUSTOMER_DB_ID: cId, KARTE_DB_ID: kId });
      return jsonRes({ ok: true, customerDbId: cId, karteDbId: kId });
    }
    if (p.action === 'devCheckConfig' && cfg._env === 'staging') {
      var allProps = PropertiesService.getScriptProperties().getProperties();
      return jsonRes({
        env:               allProps.ENV || '(unset)',
        hasToken:          !!allProps.NOTION_TOKEN,
        hasStaffPassword:  !!allProps.STAFF_PASSWORD,
        hasNotifyEmail:    !!allProps.NOTIFY_EMAIL,
        production: {
          hasCustomerDb:   !!allProps.CUSTOMER_DB_ID,
          hasKarteDb:      !!allProps.KARTE_DB_ID,
          hasLedger:       !!allProps.LEDGER_SPREADSHEET_ID,
          customerDb:      allProps.CUSTOMER_DB_ID || '',
          karteDb:         allProps.KARTE_DB_ID || '',
        },
        staging: {
          hasCustomerDb:   !!allProps.STAGING_CUSTOMER_DB_ID,
          hasKarteDb:      !!allProps.STAGING_KARTE_DB_ID,
          hasLedger:       !!allProps.STAGING_LEDGER_SPREADSHEET_ID,
        },
      });
    }
    if (p.action === 'validateToken')     return jsonRes({ valid: false });
    if (p.action === 'getPatientList') {
      var authL = verifyStaffPassword(p.pw, cfg);
      if (!authL.ok) return jsonRes({ success: false, error: authL.error, remainingSec: authL.remainingSec });
      return jsonRes(handleGetPatientList(cfg));
    }
    if (p.action === 'getPatientDetails') {
      var authD = verifyStaffPassword(p.pw, cfg);
      if (!authD.ok) return jsonRes({ success: false, error: authD.error, remainingSec: authD.remainingSec });
      return jsonRes(handleGetPatientDetails(p.customerId, cfg));
    }

    // ダッシュボード集計データ（集計値のみ・PII なし）
    if (p.action === 'getDashboardData') {
      return handleGetDashboardData(cfg);
    }

    // レガシー JSONP（index.html カレンダーのグレーアウト用。凍結）
    if (p.date && p.callback) {
      var booked = getBookedTimesForDate(p.date, cfg);
      var out = ContentService.createTextOutput(
        p.callback + '(' + JSON.stringify({ date: p.date, booked: booked }) + ')'
      );
      out.setMimeType(ContentService.MimeType.JAVASCRIPT);
      return out;
    }

    return jsonRes({ success: false, error: 'Bad request' });
  } catch (err) {
    Logger.log('doGet error: ' + err.message);
    return jsonRes({ success: false, error: err.message });
  }
}

/* ============================================================
   設定・環境
   ============================================================ */

function getConfig(env) {
  var props = PropertiesService.getScriptProperties().getProperties();
  var e = env || props.ENV || 'production';
  if (e === 'staging' && props.STAGING_CUSTOMER_DB_ID) {
    return Object.assign({}, props, {
      CUSTOMER_DB_ID:        props.STAGING_CUSTOMER_DB_ID,
      KARTE_DB_ID:           props.STAGING_KARTE_DB_ID,
      LEDGER_SPREADSHEET_ID: props.STAGING_LEDGER_SPREADSHEET_ID || '',
      _env: 'staging',
    });
  }
  return Object.assign({}, props, { _env: 'production' });
}

function resolveEnv(requested) {
  if (requested !== 'staging') return null;
  var props = PropertiesService.getScriptProperties().getProperties();
  // 本番モードのときは env=staging パラメータを無視する
  if ((props.ENV || 'production') === 'production') return null;
  return props.STAGING_CUSTOMER_DB_ID ? 'staging' : null;
}

/* ============================================================
   電話番号正規化
   ============================================================ */

function normalizePhone(raw) {
  if (!raw) return '';
  var s = String(raw);
  // 全角数字→半角
  s = s.replace(/[０-９]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  // スペース・ハイフン・括弧・プラス・ドット除去
  s = s.replace(/[\s\-\(\)\.\+]/g, '');
  // +81（プラス除去後 81 始まり）→ 0 始まりに変換
  if (/^81/.test(s)) s = '0' + s.slice(2);
  // Sheets が数値型として 0 を削除した場合（例: 9099887766）→ 先頭 0 を補完
  if (/^\d{9,10}$/.test(s) && s[0] !== '0') s = '0' + s;
  return s;
}

function isValidPhone(normalized) {
  return /^0\d{9,10}$/.test(normalized);
}

/* ============================================================
   採番（LockService 保護）
   ============================================================ */

function nextCustomerId(ss) {
  // 呼び出し元で LockService を取得してから呼ぶこと
  var sheet = ss.getSheetByName('顧客マスタ');
  var lastRow = sheet.getLastRow();
  var max = 0;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, CM.customer_id + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var n = parseInt(String(ids[i][0]).replace(/\D/g, ''), 10) || 0;
      if (n > max) max = n;
    }
  }
  return 'P' + String(max + 1).padStart(3, '0');
}

/* ============================================================
   ユーティリティ
   ============================================================ */

function genUUID() {
  return Utilities.getUuid();
}

function nowISO() {
  return new Date().toISOString();
}

function todayStr() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function fmtDate(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

// Sheets から返ってくる Date オブジェクトや文字列を YYYY-MM-DD に統一
function toDateStr(val) {
  if (!val) return '';
  if (val instanceof Date) return fmtDate(val);
  var s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function makeRow(size, values) {
  var row = new Array(size).fill('');
  for (var k in values) {
    if (values[k] !== undefined && values[k] !== null) row[k] = values[k];
  }
  return row;
}

/* ============================================================
   台帳シートアクセス
   ============================================================ */

function getLedger(cfg) {
  if (!cfg.LEDGER_SPREADSHEET_ID) throw new Error('LEDGER_SPREADSHEET_ID が未設定です');
  return SpreadsheetApp.openById(cfg.LEDGER_SPREADSHEET_ID);
}

// シートの全データを 2D 配列で返す（行0=ヘッダー、行1以降=データ）
function getSheetData(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
}

// 電話番号（正規化済み）で顧客マスタを検索。配列 or null を返す
// 複数ヒット時は配列（家族共用番号対応）
function findCustomersByPhone(ss, normalizedPhone) {
  var rows = getSheetData(ss, '顧客マスタ');
  var found = [];
  for (var i = 0; i < rows.length; i++) {
    if (normalizePhone(String(rows[i][CM.phone])) === normalizedPhone
        && String(rows[i][CM.status]) !== 'archived') {
      found.push({ rowIndex: i + 2, row: rows[i] }); // rowIndex は 1-based シート行番号
    }
  }
  return found;
}

// customer_id で顧客マスタを検索
function findCustomerById(ss, customerId) {
  var rows = getSheetData(ss, '顧客マスタ');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][CM.customer_id]) === customerId) return { rowIndex: i + 2, row: rows[i] };
  }
  return null;
}

// 顧客マスタに1行追記。LockService は呼び出し元で取得済みであること
function appendCustomer(ss, data, customerId) {
  var now = nowISO();
  var phone = normalizePhone(data.phone || '');
  var row = makeRow(15, {
    [CM.customer_id]:    customerId,
    [CM.name]:           data.name || '',
    [CM.furigana]:       data.furigana || '',
    [CM.phone]:          phone,
    [CM.email]:          data.email || '',
    [CM.dob]:            data.dob || '',
    [CM.first_visit]:    data.date || todayStr(),
    [CM.lang]:           data.lang || 'ja',
    [CM.how_found]:      data.howFound || '',
    [CM.address]:        data.address || '',
    [CM.status]:         'active',
    [CM.notion_page_id]: '',
    [CM.created_at]:     now,
    [CM.updated_at]:     now,
    [CM.synced_at]:      '',
  });
  ss.getSheetByName('顧客マスタ').appendRow(row);
  return customerId;
}

// 顧客マスタの指定行を更新（updated_at も更新する）
function updateCustomerRow(ss, rowIndex, fields) {
  var sheet = ss.getSheetByName('顧客マスタ');
  var now = nowISO();
  for (var col in fields) {
    sheet.getRange(rowIndex, parseInt(col) + 1).setValue(fields[col]);
  }
  sheet.getRange(rowIndex, CM.updated_at + 1).setValue(now);
  sheet.getRange(rowIndex, CM.synced_at + 1).setValue(''); // 再同期対象に
}

// 未同期カウンタをインクリメント
function incSyncCounter(ss, count) {
  var sheet = ss.getSheetByName('_sync');
  var cell  = sheet.getRange('A1');
  cell.setValue(Number(cell.getValue()) + (count || 1));
}

/* ============================================================
   アクセスログ
   ============================================================ */

function logAccess(ss, action, requestId, result, errorMsg, elapsedMs, customerIdHint) {
  try {
    var row = makeRow(7, {
      [AL.timestamp]:        nowISO(),
      [AL.action]:           action,
      [AL.request_id]:       requestId || '',
      [AL.result]:           result,
      [AL.error_msg]:        (errorMsg || '').slice(0, 200),
      [AL.elapsed_ms]:       elapsedMs || 0,
      [AL.customer_id_hint]: customerIdHint || '',
    });
    ss.getSheetByName('アクセスログ').appendRow(row);
  } catch(e) {
    Logger.log('logAccess error: ' + e.message);
  }
}

/* ============================================================
   ハンドラ: 患者照合（電話番号のみ / シート参照）
   ============================================================ */

function handleLookupPatient(data, cfg) {
  cfg = cfg || getConfig();
  var ss    = getLedger(cfg);
  var phone = normalizePhone(data.phone || '');

  if (!phone || !isValidPhone(phone)) return { success: true, found: false };

  var matches = findCustomersByPhone(ss, phone);

  if (matches.length === 0) return { success: true, found: false };

  if (matches.length === 1) {
    var r = matches[0].row;
    return {
      success:    true,
      found:      true,
      customerId: String(r[CM.customer_id]),
      patientNum: String(r[CM.customer_id]),
      name:       String(r[CM.name]),
      furigana:   String(r[CM.furigana]),
      email:      String(r[CM.email] || ''),
    };
  }

  // 複数ヒット → 特定不可のため未発見扱いにして初回フローへ誘導
  return { success: true, found: false };
}

function handleUpdateCustomerInfo(data, cfg) {
  var customerId = String(data.customerId || '');
  if (!customerId) return { success: false, error: 'customerId required' };

  var ss = getLedger(cfg);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var found = findCustomerById(ss, customerId);
    if (!found) return { success: false, error: 'Customer not found' };

    var fields = {};
    if (data.name)     fields[CM.name]     = String(data.name);
    if (data.furigana) fields[CM.furigana]  = String(data.furigana);
    if (data.phone)    fields[CM.phone]     = normalizePhone(String(data.phone));
    if (typeof data.email !== 'undefined') fields[CM.email] = String(data.email);

    if (Object.keys(fields).length === 0) return { success: true }; // 変更なし

    updateCustomerRow(ss, found.rowIndex, fields);
    incSyncCounter(ss);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   ハンドラ: 問診票送信（メインエントリ）
   ============================================================ */

function handleSubmitAll(data, cfg) {
  cfg = cfg || getConfig();
  var t0 = Date.now();
  var ss = getLedger(cfg);
  var customerId;

  // ── 顧客照合 or 新規作成 ──
  var phone = normalizePhone(data.phone || '');
  var lock  = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (data.visitType === 'return' && data.customerId) {
      // 再来院: フロントが渡す customerId を電話番号でサーバー側検証
      var matched = phone ? findCustomersByPhone(ss, phone) : [];
      if (matched.length === 1) {
        customerId = String(matched[0].row[CM.customer_id]);
      } else if (matched.length > 1) {
        // 複数ヒット: フロントが選択した customerId を使用（整合チェック）
        var ids = matched.map(function(m) { return String(m.row[CM.customer_id]); });
        customerId = ids.indexOf(data.customerId) >= 0 ? data.customerId : ids[0];
      } else if (data.customerId) {
        customerId = data.customerId; // 電話番号不明の場合フロント値を補助的に使用
      }
      // 既存顧客の情報更新（言語・生年月日等）
      var existing = customerId ? findCustomerById(ss, customerId) : null;
      if (existing) {
        var upd = {};
        if (data.dob && !String(existing.row[CM.dob])) upd[CM.dob] = data.dob;
        if (data.furigana) upd[CM.furigana] = data.furigana;
        if (data.lang)     upd[CM.lang]     = data.lang;
        if (Object.keys(upd).length) updateCustomerRow(ss, existing.rowIndex, upd);
      }
    } else {
      // 初回 or 再来院フォールバック: 電話番号で照合
      var existingMatches = phone ? findCustomersByPhone(ss, phone) : [];
      if (existingMatches.length >= 1) {
        customerId = String(existingMatches[0].row[CM.customer_id]);
        var upd2 = {};
        if (data.dob)      upd2[CM.dob]      = data.dob;
        if (data.furigana) upd2[CM.furigana]  = data.furigana;
        if (data.lang)     upd2[CM.lang]      = data.lang;
        if (data.howFound) upd2[CM.how_found] = data.howFound;
        if (Object.keys(upd2).length) updateCustomerRow(ss, existingMatches[0].rowIndex, upd2);
      } else {
        // 新規作成（ロック内）
        customerId = nextCustomerId(ss);
        appendCustomer(ss, data, customerId);
        incSyncCounter(ss);
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (!customerId) return { success: false, error: '顧客IDを特定できませんでした' };

  // ── 画像保存 ──
  var bodyImageUrl = '', sigUrl = '';
  var hasQ = data.visitType === 'first' || data.hasChanges === 'yes';
  if (hasQ && cfg.DRIVE_FOLDER_ID) {
    if (data.bodyImage && data.bodyImage.length > 100) {
      bodyImageUrl = saveBodyImage(cfg, data.bodyImage, customerId, '人体図');
    }
    if (data.signatureImage && data.signatureImage.length > 100) {
      sigUrl = saveBodyImage(cfg, data.signatureImage, 'sig_' + customerId, '署名');
    }
  }

  // ── 問診台帳に追記 ──
  var now      = nowISO();
  var entryId  = genUUID();
  var rawJson  = JSON.stringify({
    visitType: data.visitType, hasChanges: data.hasChanges,
    mainSymptom: data.mainSymptom, mainSymptomOther: data.mainSymptomOther,
    symptomDuration: data.symptomDuration, painLevel: data.painLevel,
    safetyCheck: data.safetyCheck, safetyNote: data.safetyNote, safetyDetail: data.safetyDetail,
    treatmentGoal: data.treatmentGoal, treatmentStrength: data.treatmentStrength,
    dislikedTreatment: data.dislikedTreatment,
    photoConsent: data.photoConsent, facePreference: data.facePreference,
    consentAgreed: data.consentAgreed, consentDate: data.consentDate,
    name: data.name, furigana: data.furigana, phone: phone,
    dob: data.dob, email: data.email, howFound: data.howFound,
    referrerName: data.referrerName, lang: data.lang,
  });

  var quRow = makeRow(24, {
    [QU.entry_id]:       entryId,
    [QU.date]:           data.date || todayStr(),
    [QU.customer_id]:    customerId,
    [QU.visit_type]:     data.visitType || 'first',
    [QU.has_changes]:    data.hasChanges || '',
    [QU.main_symptom]:   Array.isArray(data.mainSymptom) ? data.mainSymptom.join(',') : (data.mainSymptom || ''),
    [QU.duration]:       data.symptomDuration || '',
    [QU.pain_level]:     data.painLevel !== undefined && data.painLevel !== null ? data.painLevel : '',
    [QU.safety_check]:   (data.safetyCheck || []).join(','),
    [QU.safety_note]:    data.safetyNote || '',
    [QU.goal]:           data.treatmentGoal || '',
    [QU.strength]:       data.treatmentStrength || '',
    [QU.disliked]:       (data.dislikedTreatment || []).join(','),
    [QU.photo_consent]:  data.photoConsent || '',
    [QU.face_pref]:      data.facePreference || '',
    [QU.consent_agreed]: data.consentAgreed ? 'TRUE' : 'FALSE',
    [QU.consent_date]:   data.consentDate || todayStr(),
    [QU.body_image_url]: bodyImageUrl,
    [QU.sig_url]:        sigUrl,
    [QU.notion_page_id]: '',
    [QU.created_at]:     now,
    [QU.synced_at]:      '',
    [QU.error_count]:    0,
    [QU.raw_json]:       rawJson,
  });
  ss.getSheetByName('問診台帳').appendRow(quRow);
  incSyncCounter(ss);

  logAccess(ss, 'submitAll', data.requestId, 'ok', '', Date.now() - t0, customerId);
  return { success: true, patientNum: customerId };
}

/* ============================================================
   ハンドラ: スタンドアロン問診票送信（後方互換）
   ============================================================ */

function handleSubmitQuestionnaire(data, cfg) {
  cfg = cfg || getConfig();
  // submitAll と同じフロー（スタンドアロン問診票は visitType を推定）
  if (!data.visitType) data.visitType = data.booking ? 'return' : 'first';
  return handleSubmitAll(data, cfg);
}

/* ============================================================
   スタッフ認証：ブルートフォース保護
   ============================================================ */

var AUTH_MAX_ATTEMPTS = 5;
var AUTH_WINDOW_MS   = 15 * 60 * 1000;
var AUTH_LOCKOUT_MS  = 15 * 60 * 1000;

function bfKey(cfg) {
  return 'bf_staff_' + (cfg._env || 'production');
}

function checkBruteForce(cfg) {
  var props = PropertiesService.getScriptProperties();
  var raw   = props.getProperty(bfKey(cfg));
  if (!raw) return { allowed: true };
  var s   = JSON.parse(raw);
  var now = Date.now();
  if (s.lockedUntil && s.lockedUntil > now) {
    return { allowed: false, remainingSec: Math.ceil((s.lockedUntil - now) / 1000) };
  }
  if (now - (s.windowStart || 0) > AUTH_WINDOW_MS) {
    props.deleteProperty(bfKey(cfg));
    return { allowed: true };
  }
  return { allowed: true };
}

function recordAuthFail(cfg) {
  var props = PropertiesService.getScriptProperties();
  var key   = bfKey(cfg);
  var raw   = props.getProperty(key);
  var now   = Date.now();
  var s     = raw ? JSON.parse(raw) : { attempts: 0, windowStart: now };
  if (now - s.windowStart > AUTH_WINDOW_MS) s = { attempts: 0, windowStart: now };
  s.attempts++;
  if (s.attempts >= AUTH_MAX_ATTEMPTS) {
    s.lockedUntil = now + AUTH_LOCKOUT_MS;
    s.attempts    = 0;
    s.windowStart = now + AUTH_LOCKOUT_MS;
  }
  props.setProperty(key, JSON.stringify(s));
}

function recordAuthSuccess(cfg) {
  PropertiesService.getScriptProperties().deleteProperty(bfKey(cfg));
}

// GASエディタから手動実行してロックを解除する（緊急時用）
function resetAuthLock() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('bf_staff_production');
  props.deleteProperty('bf_staff_staging');
  Logger.log('Auth lock cleared for production and staging.');
}

function verifyStaffPassword(password, cfg) {
  if (!cfg.STAFF_PASSWORD) return { ok: false, error: 'config_error', message: 'STAFF_PASSWORD が設定されていません。GAS スクリプトプロパティを確認してください。' };
  var bf = checkBruteForce(cfg);
  if (!bf.allowed) return { ok: false, error: 'auth_locked', remainingSec: bf.remainingSec };
  if (!password || password !== cfg.STAFF_PASSWORD) {
    recordAuthFail(cfg);
    return { ok: false, error: 'auth_fail' };
  }
  recordAuthSuccess(cfg);
  return { ok: true };
}

/* ============================================================
   ハンドラ: スタッフ認証
   ============================================================ */

function handleVerifyStaff(p, cfg) {
  var result = verifyStaffPassword(p.pw, cfg);
  if (!result.ok) {
    try {
      var ss = getLedger(cfg);
      logAccess(ss, 'verifyStaff', p.requestId, result.error, '', 0, '');
    } catch(e) {}
  }
  return result;
}

/* ============================================================
   ハンドラ: 患者一覧取得（施術記録シート用）
   ============================================================ */

function handleGetPatientList(cfg) {
  cfg = cfg || getConfig();
  var ss = getLedger(cfg);

  var customerRows = getSheetData(ss, '顧客マスタ');
  var treatRows    = getSheetData(ss, '施術台帳');
  var today        = todayStr();

  // 今日の void 済みエントリIDを先に収集
  var voidedEntryIds = {};
  for (var v = 0; v < treatRows.length; v++) {
    if (toDateStr(treatRows[v][TR.date]) !== today) continue;
    if (String(treatRows[v][TR.type]) !== 'void') continue;
    var tgtId = String(treatRows[v][TR.target_entry_id] || '');
    if (tgtId) voidedEntryIds[tgtId] = true;
  }

  // 今日の施術台帳を集計（void済みは除外）
  var todayByCustomer = {}; // customerId → { hasSales: bool }
  for (var i = 0; i < treatRows.length; i++) {
    var r = treatRows[i];
    if (toDateStr(r[TR.date]) !== today) continue;
    if (String(r[TR.type]) !== 'record') continue;
    if (voidedEntryIds[String(r[TR.entry_id])]) continue;
    var cid = String(r[TR.customer_id]);
    var hasSales = r[TR.sales] !== '' && r[TR.sales] !== null;
    if (!todayByCustomer[cid]) {
      todayByCustomer[cid] = { hasSales: hasSales };
    } else if (hasSales) {
      todayByCustomer[cid].hasSales = true;
    }
  }

  var patients = [];
  for (var j = 0; j < customerRows.length; j++) {
    var cr = customerRows[j];
    if (!String(cr[CM.name])) continue;
    if (String(cr[CM.status]) === 'archived') continue;
    var cid2 = String(cr[CM.customer_id]);
    var today2 = todayByCustomer[cid2];
    patients.push({
      customerId:       cid2,
      patientNum:       cid2,
      name:             String(cr[CM.name]),
      furigana:         String(cr[CM.furigana]),
      creditBalance:    Number(computeCreditBalance(ss, cid2)) || 0,
      treatmentPending: today2 ? !today2.hasSales : false,
    });
  }
  return { success: true, patients: patients };
}

/* ============================================================
   ハンドラ: 患者詳細取得（クレジット・来院回数）
   ============================================================ */

function handleGetPatientDetails(customerId, cfg) {
  cfg = cfg || getConfig();
  if (!customerId) return { success: false, error: 'customerId required' };
  var ss = getLedger(cfg);

  // クレジット残高・期限切れ予告
  var creditBalance  = computeCreditBalance(ss, customerId);
  var expiringCredits = computeExpiringCredits(ss, customerId);

  // 来院履歴（施術台帳から）
  var treatRows  = getSheetData(ss, '施術台帳');
  var today      = todayStr();

  // 取消済みエントリIDを収集
  var voidedIds = {};
  for (var v = 0; v < treatRows.length; v++) {
    var vr = treatRows[v];
    if (String(vr[TR.customer_id]) !== customerId) continue;
    if (String(vr[TR.type]) !== 'void') continue;
    if (vr[TR.target_entry_id]) voidedIds[String(vr[TR.target_entry_id])] = true;
  }

  var visitDates   = [];
  var todayRecords = [];
  for (var i = 0; i < treatRows.length; i++) {
    var r = treatRows[i];
    if (String(r[TR.customer_id]) !== customerId) continue;
    if (String(r[TR.type]) !== 'record') continue;
    var eid      = String(r[TR.entry_id]);
    var isVoided = !!voidedIds[eid];
    var rDate    = toDateStr(r[TR.date]);
    if (!isVoided && String(r[TR.count_eligible]) !== 'FALSE') {
      visitDates.push(rDate);
    }
    if (rDate === today && !isVoided) {
      todayRecords.push({
        entryId:       eid,
        course:        String(r[TR.course] || ''),
        salesAmount:   Number(r[TR.sales]) || 0,
        paymentMethod: String(r[TR.payment] || ''),
        creditUsed:    Number(r[TR.credit_used]) || 0,
        memo:          String(r[TR.memo] || ''),
      });
    }
  }
  visitDates.sort().reverse();

  var visitCount   = visitDates.length;
  var lastVisit    = visitDates[0] || '';
  var prevVisit    = '';
  for (var k = 0; k < visitDates.length; k++) {
    if (visitDates[k] !== today) { prevVisit = visitDates[k]; break; }
  }

  var todayIncluded  = lastVisit === today;
  var isFirstVisit   = visitCount === 0 || (visitCount === 1 && todayIncluded);
  var visitNum       = isFirstVisit ? 1 : (todayIncluded ? visitCount : visitCount + 1);

  // 月2回コース2回目の未使用チェック（今月内）
  var curMonth = todayStr().slice(0, 7); // "YYYY-MM"
  var m2First = 0, m2Second = 0;
  for (var m = 0; m < treatRows.length; m++) {
    var mr = treatRows[m];
    if (String(mr[TR.customer_id]) !== customerId) continue;
    if (String(mr[TR.type]) !== 'record') continue;
    if (voidedIds[String(mr[TR.entry_id])]) continue;
    if (toDateStr(mr[TR.date]).slice(0, 7) !== curMonth) continue;
    if (String(mr[TR.course]) === '月2回コース') {
      if (Number(mr[TR.sales]) > 0) m2First++;
      else m2Second++;
    }
  }

  return {
    success:          true,
    creditBalance:    creditBalance,
    expiringCredits:  expiringCredits,
    visitCount:       visitCount,
    visitNum:         visitNum,
    prevVisitDate:    prevVisit,
    isFirstVisit:     isFirstVisit,
    todayRecords:     todayRecords,
    monthly2Available: m2First > m2Second,
  };
}

/* ============================================================
   ハンドラ: 施術記録送信
   ============================================================ */

function handleSubmitTreatmentRecord(data, cfg) {
  cfg = cfg || getConfig();
  var t0 = Date.now();

  // スタッフ認可（ブルートフォース保護）
  var authResult = verifyStaffPassword(data.password, cfg);
  if (!authResult.ok) {
    try {
      var ss0 = getLedger(cfg);
      logAccess(ss0, 'submitTreatmentRecord', data.requestId, authResult.error, '', 0, '');
    } catch(e) {}
    return { success: false, error: authResult.error, remainingSec: authResult.remainingSec };
  }

  var ss         = getLedger(cfg);

  // 冪等性チェック: 同一 requestId が既に成功済みなら即返す
  if (data.requestId) {
    var logSheet = ss.getSheetByName('アクセスログ');
    if (logSheet) {
      var logVals = logSheet.getDataRange().getValues();
      var start   = Math.max(1, logVals.length - 500); // 直近500行のみ走査
      for (var li = logVals.length - 1; li >= start; li--) {
        if (String(logVals[li][AL.request_id]) === String(data.requestId) &&
            String(logVals[li][AL.action])     === 'submitTreatmentRecord' &&
            String(logVals[li][AL.result])     === 'ok') {
          return { success: true, duplicate: true };
        }
      }
    }
  }

  var customerId = String(data.customerId || '');
  var now        = nowISO();
  var entryId    = genUUID();
  var courseLabel = COURSE_ID_MAP[data.courseId] || '';

  // クレジット残高チェック（書き込み前に行う）
  if (data.creditUsed && Number(data.creditUsed) > 0) {
    var balance = computeCreditBalance(ss, customerId);
    if (Number(data.creditUsed) > balance) {
      return { success: false, error: 'クレジット残高不足（残高: ¥' + balance + '）' };
    }
  }

  var trRow = makeRow(18, {
    [TR.entry_id]:             entryId,
    [TR.type]:                 'record',
    [TR.target_entry_id]:      '',
    [TR.date]:                 todayStr(),
    [TR.customer_id]:          customerId,
    [TR.course]:               courseLabel,
    [TR.sales]:                data.salesAmount !== '' && data.salesAmount !== undefined
                                 ? Number(data.salesAmount) : '',
    [TR.payment]:              data.paymentMethod || '',
    [TR.memo]:                 data.treatmentMemo || '',
    [TR.has_questionnaire]:    'FALSE',
    [TR.credit_used]:          Number(data.creditUsed) || 0,
    [TR.referrer_customer_id]: data.referrerId || '',
    [TR.count_eligible]:       'TRUE',
    [TR.notion_page_id]:       '',
    [TR.created_at]:           now,
    [TR.updated_at]:           now,
    [TR.synced_at]:            '',
    [TR.error_count]:          0,
  });
  ss.getSheetByName('施術台帳').appendRow(trRow);
  incSyncCounter(ss);

  // クレジット消費台帳に記録
  if (data.creditUsed && Number(data.creditUsed) > 0) {
    appendCreditEntry(ss, customerId, 'use', -Number(data.creditUsed), '', entryId);
  }

  // 紹介クレジット付与（初回来院の紹介者に）
  var referralLimitReached = false;
  if (data.referralDiscount && data.referrerId) {
    var grantCount = countReferralGrants(ss, data.referrerId);
    if (grantCount < 3) {
      appendCreditEntry(ss, data.referrerId, 'grant', 1000, '', entryId);
    } else {
      Logger.log('紹介クレジット上限到達: referrerId=' + data.referrerId + ' count=' + grantCount);
      referralLimitReached = true;
    }
  }

  logAccess(ss, 'submitTreatmentRecord', data.requestId, 'ok', '', Date.now() - t0, customerId);
  return { success: true, patientNum: customerId, entryId: entryId, referralLimitReached: referralLimitReached };
}

/* ============================================================
   ハンドラ: 施術記録取消（当日分のみ）
   ============================================================ */

function handleSubmitVoidRecord(data, cfg) {
  cfg = cfg || getConfig();
  var ss         = getLedger(cfg);
  var sheet      = ss.getSheetByName('施術台帳');
  var rows       = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues() : [];
  var today      = todayStr();
  var targetId   = String(data.targetEntryId || '');
  var customerId = String(data.customerId || '');

  if (!targetId || !customerId) return { success: false, error: 'targetEntryId required' };

  var origRow = null;
  var alreadyVoided = false;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][TR.entry_id]) === targetId) { origRow = rows[i]; }
    if (String(rows[i][TR.type]) === 'void' && String(rows[i][TR.target_entry_id]) === targetId) {
      alreadyVoided = true;
    }
  }
  if (!origRow)                                       return { success: false, error: 'record_not_found' };
  if (String(origRow[TR.customer_id]) !== customerId) return { success: false, error: 'record_not_found' };
  if (String(origRow[TR.type]) !== 'record')          return { success: false, error: 'already_voided' };
  if (alreadyVoided)                                  return { success: false, error: 'already_voided' };
  if (toDateStr(origRow[TR.date]) !== today)          return { success: false, error: 'past_date_void_not_allowed' };

  var now    = nowISO();
  var voidId = genUUID();
  var voidRow = makeRow(18, {
    [TR.entry_id]:             voidId,
    [TR.type]:                 'void',
    [TR.target_entry_id]:      targetId,
    [TR.date]:                 today,
    [TR.customer_id]:          customerId,
    [TR.course]:               String(origRow[TR.course] || ''),
    [TR.sales]:                -(Number(origRow[TR.sales]) || 0),
    [TR.payment]:              String(origRow[TR.payment] || ''),
    [TR.memo]:                 '【取消】' + String(origRow[TR.memo] || ''),
    [TR.has_questionnaire]:    'FALSE',
    [TR.credit_used]:          -(Number(origRow[TR.credit_used]) || 0),
    [TR.referrer_customer_id]: '',
    [TR.count_eligible]:       'FALSE',
    [TR.notion_page_id]:       '',
    [TR.created_at]:           now,
    [TR.updated_at]:           now,
    [TR.synced_at]:            now,
    [TR.error_count]:          0,
  });
  sheet.appendRow(voidRow);

  // 元 record の updated_at を更新 → 次の同期サイクルで Notion ステータスを「取消」に変更
  for (var j = 0; j < rows.length; j++) {
    if (String(rows[j][TR.entry_id]) === targetId) {
      sheet.getRange(j + 2, TR.updated_at + 1).setValue(now);
      break;
    }
  }

  incSyncCounter(ss);

  if (Number(origRow[TR.credit_used]) > 0) {
    appendCreditEntry(ss, customerId, 'refund', Number(origRow[TR.credit_used]), targetId, '');
  }

  logAccess(ss, 'voidTreatmentRecord', data.requestId || '', 'ok', '', 0, customerId);
  return { success: true };
}

/* ============================================================
   クレジット台帳ヘルパー
   ============================================================ */

function appendCreditEntry(ss, customerId, type, amount, relEntryId, grantEntryId) {
  var now    = nowISO();
  var expiry = '';
  if (type === 'grant') {
    var exp = new Date();
    exp.setFullYear(exp.getFullYear() + 1);
    expiry = fmtDate(exp);
  }
  var row = makeRow(10, {
    [CR.entry_id]:     genUUID(),
    [CR.date]:         todayStr(),
    [CR.customer_id]:  customerId,
    [CR.type]:         type,
    [CR.amount]:       amount,
    [CR.expiry]:       expiry,
    [CR.rel_entry_id]: relEntryId || grantEntryId || '',
    [CR.created_at]:   now,
    [CR.synced_at]:    '',
    [CR.error_count]:  0,
  });
  ss.getSheetByName('クレジット台帳').appendRow(row);
  incSyncCounter(ss);
}

function computeCreditBalance(ss, customerId) {
  var rows = getSheetData(ss, 'クレジット台帳');
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][CR.customer_id]) === customerId) {
      total += Number(rows[i][CR.amount]) || 0;
    }
  }
  return total;
}

function computeExpiringCredits(ss, customerId) {
  var rows  = getSheetData(ss, 'クレジット台帳');
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[CR.customer_id]) !== customerId) continue;
    if (String(r[CR.type]) !== 'grant') continue;
    if (!r[CR.expiry]) continue;
    var exp     = new Date(r[CR.expiry]);
    var daysLeft = Math.floor((exp - today) / 86400000);
    if (daysLeft >= 0 && daysLeft <= 60) {
      result.push({ amount: r[CR.amount], daysLeft: daysLeft, expiryDate: fmtDate(exp) });
    }
  }
  return result;
}

// 紹介 grant 行数を数える（上限チェック用）
function countReferralGrants(ss, referrerId) {
  var rows  = getSheetData(ss, 'クレジット台帳');
  var count = 0;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][CR.customer_id]) === referrerId
        && String(rows[i][CR.type]) === 'grant') count++;
  }
  return count;
}

/* ============================================================
   Notion 同期トリガー（1分毎）
   ============================================================ */

function syncToNotion() {
  var cfg = getConfig();

  // Drive フォルダ未設定なら自動設定（ステージング専用。本番では絶対に上書きしない）
  if (!cfg.DRIVE_FOLDER_ID && cfg._env === 'staging') {
    try {
      var stagingFolderId = '1F7nAzq-MAGUmrnXm__yyQjyVaV7xanuh';
      PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', stagingFolderId);
      cfg.DRIVE_FOLDER_ID = stagingFolderId;
      Logger.log('syncToNotion: Drive フォルダ自動設定 ' + stagingFolderId);
    } catch(e) {
      Logger.log('syncToNotion: Drive フォルダ設定失敗 ' + e.message);
    }
  }

  var ss;
  try {
    ss = getLedger(cfg);
  } catch(e) {
    Logger.log('syncToNotion: getLedger failed: ' + e.message);
    return;
  }

  var syncSheet = ss.getSheetByName('_sync');
  var counter   = Number(syncSheet.getRange('A1').getValue());
  var lastFull  = syncSheet.getRange('B1').getValue();
  var formatted = syncSheet.getRange('C1').getValue();
  var needFull  = !lastFull || (Date.now() - new Date(lastFull).getTime()) > 3600000;

  // ヘッダー未適用なら自動フォーマット
  if (!formatted) {
    try {
      applySheetHeaders(ss);
      syncSheet.getRange('C1').setValue('formatted');
      Logger.log('syncToNotion: シートヘッダー自動適用完了');
    } catch(e) {
      Logger.log('syncToNotion: ヘッダー適用失敗 ' + e.message);
    }
  }

  Logger.log('syncToNotion: counter=' + counter + ', needFull=' + needFull);
  if (!needFull && counter <= 0) { Logger.log('syncToNotion: early return'); return; }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('syncToNotion: lock busy, skip'); return; }

  try {
    var synced = 0;
    synced += syncCustomerMaster(ss, cfg);
    synced += syncQuestionnaire(ss, cfg);
    synced += syncTreatment(ss, cfg);
    synced += syncCredit(ss, cfg);

    // カウンタ再計算
    var newCounter = countUnsyncedRows(ss);
    syncSheet.getRange('A1').setValue(newCounter);
    if (needFull) syncSheet.getRange('B1').setValue(nowISO());
    Logger.log('syncToNotion: synced=' + synced + ', remaining=' + newCounter);
  } finally {
    lock.releaseLock();
  }
}

function countUnsyncedRows(ss) {
  var count = 0;
  var tabIdx = [
    { name: '顧客マスタ',    syncedAtIdx: CM.synced_at },
    { name: '問診台帳',      syncedAtIdx: QU.synced_at },
    { name: '施術台帳',      syncedAtIdx: TR.synced_at },
    { name: 'クレジット台帳', syncedAtIdx: CR.synced_at },
  ];
  for (var t = 0; t < tabIdx.length; t++) {
    var rows = getSheetData(ss, tabIdx[t].name);
    var idx  = tabIdx[t].syncedAtIdx;
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i][idx] || rows[i][idx] === '') count++;
    }
  }
  return count;
}

// 顧客マスタ → Notion 顧客マスタ DB upsert
function syncCustomerMaster(ss, cfg) {
  var sheet = ss.getSheetByName('顧客マスタ');
  var rows  = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 15).getValues() : [];
  var synced = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var updatedAt = String(r[CM.updated_at]);
    var syncedAt  = String(r[CM.synced_at]);
    if (syncedAt && syncedAt >= updatedAt) continue; // 同期済み
    try {
      var pageId = String(r[CM.notion_page_id]);
      var langMap = { ja: 'ja', es: 'es', pt: 'pt' };
      var props = {
        '名前':          { title: [{ text: { content: String(r[CM.name]) } }] },
        'フリガナ':       richText(String(r[CM.furigana])),
        '電話番号':       { phone_number: String(r[CM.phone]) || null },
        'メールアドレス': { email: String(r[CM.email]) || null },
        '診察番号':       richText(String(r[CM.customer_id])),
        '言語':           { select: langMap[String(r[CM.lang])] ? { name: String(r[CM.lang]) } : null },
      };
      if (r[CM.dob])         props['生年月日']   = { date: { start: toDateStr(r[CM.dob]) } };
      if (r[CM.first_visit]) props['初回訪問日'] = { date: { start: toDateStr(r[CM.first_visit]) } };
      if (r[CM.how_found])   props['来院のきっかけ'] = { multi_select: [{ name: VALUE_LABEL[String(r[CM.how_found])] || String(r[CM.how_found]) }] };

      if (!pageId) {
        Logger.log('syncCM: creating page for row ' + (i+2) + ' ' + r[CM.customer_id]);
        var res = notionPost(cfg, '/pages', { parent: { database_id: cfg.CUSTOMER_DB_ID }, properties: props });
        pageId  = res.id;
        sheet.getRange(i + 2, CM.notion_page_id + 1).setValue(pageId);
        Logger.log('syncCM: created page_id=' + pageId);
      } else {
        notionPatch(cfg, '/pages/' + pageId, { properties: props });
      }
      sheet.getRange(i + 2, CM.synced_at + 1).setValue(updatedAt);
      Utilities.sleep(350);
      synced++;
    } catch(e) {
      Logger.log('syncCustomerMaster error row=' + (i+2) + ': ' + e.message);
      sheet.getRange(i + 2, CM.synced_at + 1).setValue('');
    }
  }
  return synced;
}

// 問診台帳 → Notion カルテ作成 + 問診ブロック追記
function syncQuestionnaire(ss, cfg) {
  var sheet = ss.getSheetByName('問診台帳');
  var rows  = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 24).getValues() : [];
  var synced = 0;

  for (var i = 0; i < rows.length; i++) {
    var r        = rows[i];
    var syncedAt = String(r[QU.synced_at]);
    if (syncedAt) continue; // 同期済み
    var errCount = Number(r[QU.error_count] || 0);
    if (errCount >= 5) continue;

    try {
      var custId = String(r[QU.customer_id]);
      // 顧客マスタから Notion 顧客ページID を取得
      var custData = findCustomerById(ss, custId);
      var custNotionId = custData ? String(custData.row[CM.notion_page_id]) : '';

      var pageId = String(r[QU.notion_page_id]);
      var wasExistingPage = !!pageId;
      if (!pageId) {
        // Notion カルテページ新規作成
        var dateLabel = toDateStr(r[QU.date]).replace(/-/g, '/');
        var title     = (custData ? String(custData.row[CM.name]) : String(r[QU.customer_id])) + ' (' + dateLabel + ')';
        var langMap2  = { ja: '日本語', es: 'Español', pt: 'Português' };
        var lang      = custData ? String(custData.row[CM.lang]) : 'ja';
        var karteProps = {
          '名前':      { title: [{ text: { content: title } }] },
          '日付':      { date: { start: toDateStr(r[QU.date]) } },
          'ステータス': { status: { name: '未着手' } },
          '対応言語':  { select: { name: langMap2[lang] || '日本語' } },
          '問診票':    { checkbox: true },
        };
        if (custNotionId) karteProps['顧客マスタ'] = { relation: [{ id: custNotionId }] };
        var newPage = notionPost(cfg, '/pages', { parent: { database_id: cfg.KARTE_DB_ID }, properties: karteProps });
        pageId = newPage.id;
        sheet.getRange(i + 2, QU.notion_page_id + 1).setValue(pageId);
        Utilities.sleep(350);
      }

      // 問診ブロック追記（raw_json から）
      // 再試行時の重複防止: 既存ページにすでにブロックがあればスキップ
      var skipBlocks = false;
      if (wasExistingPage) {
        try {
          var chk = UrlFetchApp.fetch(NOTION_API + '/blocks/' + pageId + '/children?page_size=1', {
            headers: notionHeaders(cfg), muteHttpExceptions: true,
          });
          var chkData = JSON.parse(chk.getContentText());
          skipBlocks = !!(chkData.results && chkData.results.length > 0);
          Utilities.sleep(200);
        } catch(chkErr) {
          Logger.log('syncQuestionnaire: block check failed, will attempt append: ' + chkErr.message);
        }
      }
      var rawJson = String(r[QU.raw_json]);
      if (!skipBlocks && rawJson && pageId) {
        var payload = JSON.parse(rawJson);
        payload.date = String(r[QU.date]);
        appendQuestionnaireBlocks(cfg, pageId, payload, String(r[QU.body_image_url]), String(r[QU.sig_url]));
        Utilities.sleep(350);
      }

      sheet.getRange(i + 2, QU.synced_at + 1).setValue(nowISO());

      // Lucas に Notion 更新通知
      if (cfg.NOTIFY_EMAIL) {
        try {
          var custName = custData ? String(custData.row[CM.name]) : String(r[QU.customer_id]);
          var dateStr  = toDateStr(r[QU.date]);
          GmailApp.sendEmail(
            cfg.NOTIFY_EMAIL,
            '【LBC Care】新しい問診票が届きました',
            custName + ' さん（' + String(r[QU.customer_id]) + '）の問診票が ' + dateStr + ' に Notion カルテへ追加されました。\n\n' +
            'Notion: https://notion.so/' + pageId.replace(/-/g,'')
          );
        } catch(mailErr) {
          Logger.log('通知メール送信失敗: ' + mailErr.message);
        }
      }
      synced++;
    } catch(e) {
      Logger.log('syncQuestionnaire error row=' + (i+2) + ': ' + e.message);
      var cnt = Number(rows[i][QU.error_count] || 0) + 1;
      sheet.getRange(i + 2, QU.error_count + 1).setValue(cnt);
      if (cnt >= 5) {
        notifyError('syncQuestionnaire row=' + (i+2), e);
      }
    }
  }
  return synced;
}

// 施術台帳 → Notion カルテプロパティ更新
function syncTreatment(ss, cfg) {
  var sheet = ss.getSheetByName('施術台帳');
  var rows  = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues() : [];
  var quRows = getSheetData(ss, '問診台帳');
  var synced = 0;

  // 赤伝畳み込み: void された record の entry_id を収集
  var voidedSet = {};
  for (var v = 0; v < rows.length; v++) {
    if (String(rows[v][TR.type]) === 'void' && rows[v][TR.target_entry_id]) {
      voidedSet[String(rows[v][TR.target_entry_id])] = true;
    }
  }

  for (var i = 0; i < rows.length; i++) {
    var r        = rows[i];
    var updatedAt = String(r[TR.updated_at]);
    var syncedAt  = String(r[TR.synced_at]);
    if (syncedAt && syncedAt >= updatedAt) continue;
    var errCount = Number(r[TR.error_count] || 0);
    if (errCount >= 5) continue;
    if (String(r[TR.type]) === 'void' || String(r[TR.type]) === 'correction') continue;

    try {
      var pageId   = String(r[TR.notion_page_id]);
      var custId   = String(r[TR.customer_id]);
      var custData = findCustomerById(ss, custId);
      var custNotionId = custData ? String(custData.row[CM.notion_page_id]) : '';

      if (!pageId) {
        // 同日の問診台帳エントリから Notion ページIDを探す
        var trDate = String(r[TR.date]);
        for (var q = 0; q < quRows.length; q++) {
          if (String(quRows[q][QU.customer_id]) === custId
              && String(quRows[q][QU.date]) === trDate
              && String(quRows[q][QU.notion_page_id])) {
            pageId = String(quRows[q][QU.notion_page_id]);
            break;
          }
        }
      }

      if (!pageId) {
        // 問診なし来院 → カルテページを新規作成
        var dateLabel2 = String(r[TR.date]).replace(/-/g, '/');
        var title2 = (custData ? String(custData.row[CM.name]) : custId) + ' (' + dateLabel2 + ')';
        var langMap3 = { ja: '日本語', es: 'Español', pt: 'Português' };
        var lang2 = custData ? String(custData.row[CM.lang]) : 'ja';
        var newKarteProps = {
          '名前':      { title: [{ text: { content: title2 } }] },
          '日付':      { date: { start: toDateStr(r[TR.date]) } },
          'ステータス': { status: { name: '完了' } },
          '対応言語':  { select: { name: langMap3[lang2] || '日本語' } },
          '問診票':    { checkbox: false },
        };
        if (custNotionId) newKarteProps['顧客マスタ'] = { relation: [{ id: custNotionId }] };
        var newP = notionPost(cfg, '/pages', { parent: { database_id: cfg.KARTE_DB_ID }, properties: newKarteProps });
        pageId   = newP.id;
        Utilities.sleep(350);
      }

      var isVoided = !!voidedSet[String(r[TR.entry_id])];
      var props = { 'ステータス': { status: { name: isVoided ? '取消' : '完了' } } };
      if (r[TR.course] && VALID_COURSES.indexOf(String(r[TR.course])) >= 0) {
        props['コース'] = { select: { name: String(r[TR.course]) } };
      }
      if (r[TR.sales] !== '') props['売上金額']   = { number: Number(r[TR.sales]) };
      if (r[TR.payment])      props['支払い方法'] = { select: { name: String(r[TR.payment]) } };
      if (r[TR.memo])         props['施術メモ']   = richText(String(r[TR.memo]));
      if (r[TR.credit_used])  props['クレジット使用額'] = { number: Number(r[TR.credit_used]) };
      if (r[TR.referrer_customer_id]) {
        var refId   = String(r[TR.referrer_customer_id]);
        var refData = findCustomerById(ss, refId);
        var refName = refData ? String(refData.row[CM.name]) + ' (' + refId + ')' : refId;
        props['紹介者名'] = richText(refName);
      }

      notionPatch(cfg, '/pages/' + pageId, { properties: props });
      sheet.getRange(i + 2, TR.notion_page_id + 1).setValue(pageId);
      sheet.getRange(i + 2, TR.synced_at + 1).setValue(updatedAt);
      Utilities.sleep(350);
      synced++;
    } catch(e) {
      Logger.log('syncTreatment error row=' + (i+2) + ': ' + e.message);
      var cnt2 = Number(rows[i][TR.error_count] || 0) + 1;
      sheet.getRange(i + 2, TR.error_count + 1).setValue(cnt2);
      if (cnt2 >= 5) notifyError('syncTreatment row=' + (i+2), e);
    }
  }
  return synced;
}

// クレジット台帳 → Notion 顧客ページの残高プロパティ更新
function syncCredit(ss, cfg) {
  var rows = getSheetData(ss, 'クレジット台帳');
  var sheet = ss.getSheetByName('クレジット台帳');
  var needUpdate = {}; // customerId → true
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][CR.synced_at]) needUpdate[String(rows[i][CR.customer_id])] = true;
  }
  var synced = 0;
  for (var custId in needUpdate) {
    try {
      var custData = findCustomerById(ss, custId);
      if (!custData) continue;
      var notionId = String(custData.row[CM.notion_page_id]);
      if (!notionId) continue;
      var balance = computeCreditBalance(ss, custId);

      // 最も近い未来の有効期限を取得（残高>0 の場合のみ）
      var earliestExpiry = null;
      if (balance > 0) {
        var today = todayStr();
        for (var k = 0; k < rows.length; k++) {
          if (String(rows[k][CR.customer_id]) !== custId) continue;
          if (String(rows[k][CR.type]) !== 'grant') continue;
          var expVal = toDateStr(rows[k][CR.expiry]);
          if (!expVal || expVal < today) continue;
          if (!earliestExpiry || expVal < earliestExpiry) earliestExpiry = expVal;
        }
      }

      notionPatch(cfg, '/pages/' + notionId, {
        properties: {
          'クレジット残高':   { number: balance },
          'クレジット有効期限': earliestExpiry ? { date: { start: earliestExpiry } } : { date: null },
        },
      });
      Utilities.sleep(350);
      // 対象顧客の全クレジット行に synced_at を書く
      for (var j = 0; j < rows.length; j++) {
        if (String(rows[j][CR.customer_id]) === custId && !rows[j][CR.synced_at]) {
          sheet.getRange(j + 2, CR.synced_at + 1).setValue(nowISO());
        }
      }
      synced++;
    } catch(e) {
      Logger.log('syncCredit error custId=' + custId + ': ' + e.message);
    }
  }
  return synced;
}

/* ============================================================
   トリガー管理
   ============================================================ */

function installTriggers() {
  // 既存トリガー削除（重複防止）
  ScriptApp.getProjectTriggers().forEach(function(t) {
    ScriptApp.deleteTrigger(t);
  });

  var cfg = getConfig();

  // 1. 同期トリガー: 1分毎
  ScriptApp.newTrigger('syncToNotion')
    .timeBased().everyMinutes(1).create();

  // 2. onEdit（インストーラブル）: 顧客マスタ編集で updated_at を自動更新
  if (cfg.LEDGER_SPREADSHEET_ID) {
    ScriptApp.newTrigger('onLedgerEdit')
      .forSpreadsheet(cfg.LEDGER_SPREADSHEET_ID)
      .onEdit().create();
  }

  // 3. 日次サマリメール: 毎朝8時
  ScriptApp.newTrigger('sendDailySummary')
    .timeBased().atHour(8).everyDays(1).create();

  Logger.log('トリガー設置完了: syncToNotion(1分毎) + onLedgerEdit + sendDailySummary(毎朝8時)');
}

function onLedgerEdit(e) {
  try {
    var sheet = e.source.getActiveSheet();
    if (sheet.getName() !== '顧客マスタ') return;
    var range = e.range;
    var now   = nowISO();
    for (var i = 1; i <= range.getNumRows(); i++) {
      var row = range.getRow() + i - 1;
      if (row < 2) continue; // ヘッダー行はスキップ
      sheet.getRange(row, CM.updated_at + 1).setValue(now);
      sheet.getRange(row, CM.synced_at + 1).setValue(''); // 再同期対象
    }
    // _sync インクリメント
    var ss        = e.source;
    var syncSheet = ss.getSheetByName('_sync');
    if (syncSheet) {
      var cell = syncSheet.getRange('A1');
      cell.setValue(Number(cell.getValue()) + 1);
    }
  } catch(err) {
    Logger.log('onLedgerEdit error: ' + err.message);
  }
}

/* ============================================================
   日次サマリメール
   ============================================================ */

function sendDailySummary() {
  try {
    var cfg  = getConfig();
    var ss   = getLedger(cfg);
    var yesterday = fmtDate(new Date(Date.now() - 86400000));

    // クレジット失効バッチ（本番のみ実行）
    var expiredCount = 0;
    if (cfg._env !== 'staging') {
      expiredCount = expireCredits(ss);
    }

    var treatRows  = getSheetData(ss, '施術台帳');
    var crRows     = getSheetData(ss, 'クレジット台帳');
    var logRows    = getSheetData(ss, 'アクセスログ');

    // 取消エントリのtarget IDを収集
    var voidedIds = {};
    for (var v = 0; v < treatRows.length; v++) {
      if (toDateStr(treatRows[v][TR.date]) === yesterday && String(treatRows[v][TR.type]) === 'void') {
        var tgt = String(treatRows[v][TR.target_entry_id] || '');
        if (tgt) voidedIds[tgt] = true;
      }
    }

    var visits = 0, sales = 0, syncErrors = 0, authFails = 0;
    for (var i = 0; i < treatRows.length; i++) {
      var r = treatRows[i];
      var rDate = toDateStr(r[TR.date]);
      var rType = String(r[TR.type]);
      if (rDate === yesterday && rType === 'record' && String(r[TR.count_eligible]) !== 'FALSE') {
        if (!voidedIds[String(r[TR.entry_id])]) {
          visits++;
          sales += Number(r[TR.sales]) || 0;
        }
      }
      if (Number(r[TR.error_count]) >= 5) syncErrors++;
    }

    // クレジット台帳の当日付与・消費集計
    var creditGrantCount = 0, creditGrantAmt = 0, creditUseCount = 0, creditUseAmt = 0;
    for (var c = 0; c < crRows.length; c++) {
      var cr = crRows[c];
      if (toDateStr(cr[CR.date]) !== yesterday) continue;
      var crType = String(cr[CR.type]);
      var crAmt  = Number(cr[CR.amount]) || 0;
      if (crType === 'grant') { creditGrantCount++; creditGrantAmt += crAmt; }
      if (crType === 'use')   { creditUseCount++;   creditUseAmt  += Math.abs(crAmt); }
    }

    for (var j = 0; j < logRows.length; j++) {
      var ts = String(logRows[j][AL.timestamp] || '');
      if (ts.startsWith(yesterday)) {
        if (String(logRows[j][AL.result]) === 'auth_fail') authFails++;
      }
    }

    var body = [
      '【LBC Care 日次サマリ】 ' + yesterday,
      '',
      '来院数: ' + visits + '件',
      '売上合計: ¥' + sales.toLocaleString(),
      '',
      'クレジット付与: ' + creditGrantCount + '件 ¥' + creditGrantAmt.toLocaleString(),
      'クレジット消費: ' + creditUseCount   + '件 ¥' + creditUseAmt.toLocaleString(),
      'クレジット失効処理: ' + expiredCount + '件',
      '',
      '同期エラー累積5回以上の行: ' + syncErrors + '件',
      '認証失敗: ' + authFails + '件',
      '',
      '台帳: https://docs.google.com/spreadsheets/d/' + cfg.LEDGER_SPREADSHEET_ID,
      '環境: ' + (cfg._env || 'production'),
    ].join('\n');

    MailApp.sendEmail({ to: cfg.NOTIFY_EMAIL, subject: '【LBC Care】日次サマリ ' + yesterday, body: body });
  } catch(e) {
    Logger.log('sendDailySummary error: ' + e.message);
  }
}

/* ============================================================
   クレジット失効バッチ（sendDailySummary から呼び出し）
   ============================================================ */

function expireCredits(ss) {
  try {
    var cfg  = ss ? null : getConfig();
    if (!ss) ss = getLedger(cfg || getConfig());
    var rows  = getSheetData(ss, 'クレジット台帳');
    var today = todayStr();
    var count = 0;

    // 期限切れ grant を顧客単位で収集
    var expiredGrants = {}; // custId → [{entryId, amount}]
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r[CR.type]) !== 'grant') continue;
      var expiry = toDateStr(r[CR.expiry]);
      if (!expiry || expiry >= today) continue;
      var cid = String(r[CR.customer_id]);
      if (!expiredGrants[cid]) expiredGrants[cid] = [];
      expiredGrants[cid].push({ entryId: String(r[CR.entry_id]), amount: Number(r[CR.amount]) });
    }

    // 既に expire 済みの grant entry_id を収集
    var doneSet = {};
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j][CR.type]) === 'expire') {
        doneSet[String(rows[j][CR.rel_entry_id])] = true;
      }
    }

    for (var custId in expiredGrants) {
      var balance = computeCreditBalance(ss, custId);
      if (balance <= 0) continue;
      var grants = expiredGrants[custId];
      for (var k = 0; k < grants.length; k++) {
        var g = grants[k];
        if (doneSet[g.entryId]) continue;
        var expireAmt = Math.min(g.amount, balance);
        if (expireAmt <= 0) continue;
        appendCreditEntry(ss, custId, 'expire', -expireAmt, g.entryId, '');
        balance -= expireAmt;
        count++;
        Logger.log('expireCredits: custId=' + custId + ' grant=' + g.entryId + ' amount=' + expireAmt);
      }
    }

    Logger.log('expireCredits: 計' + count + '件の失効処理完了');
    return count;
  } catch(e) {
    Logger.log('expireCredits error: ' + e.message);
    notifyError('expireCredits', e);
    return 0;
  }
}

/* ============================================================
   エラー通知
   ============================================================ */

// 指定日のアクセスログ内訳と施術台帳スタック行の詳細を返す
function getDetailedReport(targetDate) {
  var cfg     = getConfig();
  var ss      = getLedger(cfg);
  var date    = targetDate || fmtDate(new Date(Date.now() - 86400000));
  var logRows = getSheetData(ss, 'アクセスログ');
  var trRows  = getSheetData(ss, '施術台帳');

  // アクセスログ全件（指定日）
  var authFailDetails = [];
  var successDetails  = [];
  logRows.forEach(function(r) {
    var ts  = String(r[AL.timestamp] || '');
    var res = String(r[AL.result]    || '');
    var act = String(r[AL.action]    || '');
    if (!ts.startsWith(date)) return;
    if (res === 'auth_fail') {
      authFailDetails.push({ time: ts.slice(11,19), action: act });
    }
    if (res === 'ok' && act === 'submitTreatmentRecord') {
      successDetails.push({ time: ts.slice(11,19), requestId: String(r[AL.request_id] || ''), customerId: String(r[AL.customer_id_hint] || '') });
    }
  });

  // 施術台帳の全行詳細（指定日）
  var allTreatRows = [];
  trRows.forEach(function(r, i) {
    var rDate = toDateStr(r[TR.date]);
    if (rDate !== date) return;
    allTreatRows.push({
      row:        i + 2,
      entryId:    String(r[TR.entry_id]         || ''),
      type:       String(r[TR.type]             || ''),
      customer:   String(r[TR.customer_id]      || ''),
      course:     String(r[TR.course]           || ''),
      sales:      Number(r[TR.sales])           || 0,
      payment:    String(r[TR.payment]          || ''),
      memo:       String(r[TR.memo]             || '').slice(0, 40),
      eligible:   String(r[TR.count_eligible]   || ''),
      createdAt:  String(r[TR.created_at]       || '').slice(11,19),
      errCount:   Number(r[TR.error_count])     || 0,
      notionId:   String(r[TR.notion_page_id]   || ''),
    });
  });

  return { date: date, authFails: authFailDetails, submitOk: successDetails, treatments: allTreatRows };
}

// GASエディタから実行して Notion 接続・トリガー・スタック行を一括診断する
function diagnoseSyncIssues() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  var out = [];

  // 1. Notion トークン疎通確認
  try {
    var res = UrlFetchApp.fetch('https://api.notion.com/v1/users/me', {
      headers: { 'Authorization': 'Bearer ' + cfg.NOTION_TOKEN, 'Notion-Version': '2022-06-28' },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 200) {
      out.push('✅ Notion API トークン: 正常 (200)');
    } else {
      var body = JSON.parse(res.getContentText());
      out.push('❌ Notion API トークン: エラー ' + code + ' — ' + (body.message || body.code));
    }
  } catch(e) { out.push('❌ Notion API 疎通失敗: ' + e.message); }

  // 2. 顧客マスタDB接続確認
  try {
    var dbRes = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + cfg.CUSTOMER_DB_ID, {
      headers: { 'Authorization': 'Bearer ' + cfg.NOTION_TOKEN, 'Notion-Version': '2022-06-28' },
      muteHttpExceptions: true,
    });
    out.push(dbRes.getResponseCode() === 200
      ? '✅ 顧客マスタDB: アクセス可'
      : '❌ 顧客マスタDB: ' + dbRes.getResponseCode() + ' — インテグレーションが DB に接続されているか確認');
  } catch(e) { out.push('❌ 顧客マスタDB確認失敗: ' + e.message); }

  // 3. カルテDB接続確認
  try {
    var kRes = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + cfg.KARTE_DB_ID, {
      headers: { 'Authorization': 'Bearer ' + cfg.NOTION_TOKEN, 'Notion-Version': '2022-06-28' },
      muteHttpExceptions: true,
    });
    out.push(kRes.getResponseCode() === 200
      ? '✅ カルテDB: アクセス可'
      : '❌ カルテDB: ' + kRes.getResponseCode() + ' — インテグレーションが DB に接続されているか確認');
  } catch(e) { out.push('❌ カルテDB確認失敗: ' + e.message); }

  // 4. 同期トリガー確認
  var triggers = ScriptApp.getProjectTriggers().map(function(t) { return t.getHandlerFunction(); });
  out.push(triggers.indexOf('syncToNotion') >= 0
    ? '✅ syncToNotion トリガー: 稼働中'
    : '❌ syncToNotion トリガー: 停止 — installTriggers() を実行してください');

  // 5. スタック行（error_count >= 5）の件数確認
  var sheets = ['顧客マスタ','施術台帳'];
  var errCols = [CM.error_count, TR.error_count];
  sheets.forEach(function(name, si) {
    try {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      var vals = sh.getDataRange().getValues().slice(1);
      var stuck = vals.filter(function(r) { return Number(r[errCols[si]]) >= 5; }).length;
      out.push(stuck > 0
        ? '⚠ ' + name + ': error_count>=5 のスタック行が ' + stuck + ' 件 → resetSyncErrors() で解除'
        : '✅ ' + name + ': スタック行なし');
    } catch(e) { out.push('⚠ ' + name + ' 確認失敗: ' + e.message); }
  });

  var report = out.join('\n');
  Logger.log(report);
  if (cfg.NOTIFY_EMAIL) {
    MailApp.sendEmail({ to: cfg.NOTIFY_EMAIL, subject: '【LBC Care】Notion 同期診断レポート', body: report });
  }
  return report;
}

// error_count >= 5 のスタック行をリセットして再同期対象に戻す
function resetSyncErrors() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  var count = 0;
  [
    { name: '顧客マスタ',  errCol: CM.error_count, syncCol: CM.synced_at },
    { name: '施術台帳',    errCol: TR.error_count, syncCol: TR.synced_at },
    { name: 'クレジット台帳', errCol: CR.error_count, syncCol: CR.synced_at },
  ].forEach(function(def) {
    var sh = ss.getSheetByName(def.name);
    if (!sh) return;
    var vals = sh.getDataRange().getValues().slice(1);
    vals.forEach(function(r, i) {
      if (Number(r[def.errCol]) >= 5) {
        sh.getRange(i + 2, def.errCol  + 1).setValue(0);
        sh.getRange(i + 2, def.syncCol + 1).setValue('');
        count++;
      }
    });
  });
  Logger.log('resetSyncErrors: ' + count + '件リセット完了');
  return count;
}

function notifyError(action, err) {
  try {
    var cfg = getConfig();
    if (!cfg.NOTIFY_EMAIL) return;
    MailApp.sendEmail({
      to:      cfg.NOTIFY_EMAIL,
      subject: '[LBC Care エラー] ' + action,
      body:    'action: ' + action + '\nerror: ' + err.message + '\n\nstack:\n' + (err.stack || ''),
    });
  } catch(e) {}
}

/* ============================================================
   【凍結】予約フォーム関連（index.html 用。変更禁止）
   ============================================================ */

function handleSubmitBooking(data, cfg) {
  cfg = cfg || getConfig();
  var ss = getLedger(cfg);
  var phone = normalizePhone(data.phone || '');
  var customerId;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var matches = phone ? findCustomersByPhone(ss, phone) : [];
    if (matches.length >= 1) {
      customerId = String(matches[0].row[CM.customer_id]);
    } else if (data.email) {
      // メールで照合（後方互換）
      var allRows = getSheetData(ss, '顧客マスタ');
      for (var i = 0; i < allRows.length; i++) {
        if (String(allRows[i][CM.email]).toLowerCase() === data.email.toLowerCase()) {
          customerId = String(allRows[i][CM.customer_id]);
          break;
        }
      }
    }
    if (!customerId) {
      customerId = nextCustomerId(ss);
      appendCustomer(ss, data, customerId);
      incSyncCounter(ss);
    }
  } finally {
    lock.releaseLock();
  }

  // 施術台帳に予約エントリ追記
  var now = nowISO();
  var courseLabel = COURSE_ID_MAP[data.courseId] || COURSE_NAME_MAP[data.courseName] || '';
  var trRow = makeRow(18, {
    [TR.entry_id]:          genUUID(),
    [TR.type]:              'record',
    [TR.date]:              data.date || todayStr(),
    [TR.customer_id]:       customerId,
    [TR.course]:            courseLabel,
    [TR.has_questionnaire]: 'FALSE',
    [TR.count_eligible]:    'TRUE',
    [TR.created_at]:        now,
    [TR.updated_at]:        now,
    [TR.synced_at]:         '',
    [TR.error_count]:       0,
  });
  ss.getSheetByName('施術台帳').appendRow(trRow);
  incSyncCounter(ss);

  if (data.email) sendBookingEmail(cfg, data, customerId, true);

  return { success: true, bookingNumber: customerId };
}

function getMonthSlots(monthStr, cfg) {
  if (!monthStr) return { success: false, error: 'month required' };
  var parts = monthStr.split('-').map(Number);
  var y = parts[0], m = parts[1];
  var days = new Date(y, m, 0).getDate();
  var today = new Date(); today.setHours(0,0,0,0);
  var allTimes = [];
  for (var h = 8; h < 22; h++) {
    for (var min of [0, 30]) {
      allTimes.push(String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0'));
    }
  }
  var startDate = fmtDate(new Date(y, m - 1, 1));
  var endDate   = fmtDate(new Date(y, m - 1, days));
  var bookedByDate = getAllBookingsForMonth(cfg, startDate, endDate);
  var result = {};
  for (var d = 1; d <= days; d++) {
    var dt = new Date(y, m - 1, d);
    if (dt < today) continue;
    var ds    = fmtDate(dt);
    var booked = bookedByDate[ds] || [];
    result[ds] = allTimes.filter(function(t) { return booked.indexOf(t) < 0; });
  }
  return { success: true, slots: result };
}

function getAllBookingsForMonth(cfg, startDate, endDate) {
  try {
    var ss = getLedger(cfg);
    var rows = getSheetData(ss, '施術台帳');
    var byDate = {};
    for (var i = 0; i < rows.length; i++) {
      var r    = rows[i];
      var date = String(r[TR.date]);
      var time = String(r[TR.updated_at] || ''); // 予約時間列がないため暫定
      if (date >= startDate && date <= endDate) {
        if (!byDate[date]) byDate[date] = [];
        // 予約時間列は凍結中のため未実装
      }
    }
    return byDate;
  } catch(e) {
    Logger.log('getAllBookingsForMonth error: ' + e.message);
    return {};
  }
}

function getBookedTimesForDate(dateStr, cfg) {
  try {
    var ss   = getLedger(cfg);
    var rows = getSheetData(ss, '施術台帳');
    var times = [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][TR.date]) === dateStr) {
        // 予約時間列は凍結中のため未実装
      }
    }
    return times;
  } catch(e) {
    return [];
  }
}

/* ============================================================
   Notion 問診ブロック構築（同期トリガーから呼ばれる）
   ============================================================ */

function appendQuestionnaireBlocks(cfg, karteId, data, bodyImageUrl, signatureUrl) {
  var sep = '、';

  var ageStr = '';
  if (data.dob) {
    var parts = data.dob.split('-');
    if (parts.length === 3) {
      var today = new Date();
      var age   = today.getFullYear() - parseInt(parts[0]);
      var bMonth = parseInt(parts[1]), bDay = parseInt(parts[2]);
      if (today.getMonth() + 1 < bMonth || (today.getMonth() + 1 === bMonth && today.getDate() < bDay)) age--;
      if (age >= 0 && age <= 130) ageStr = '（' + age + '歳）';
    }
  }

  var howFoundLabel = '';
  if (data.howFound) {
    howFoundLabel = VALUE_LABEL[data.howFound] || data.howFound;
    if (data.howFound === 'referral' && data.referrerName) howFoundLabel += ' (' + data.referrerName + ')';
    if (data.howFound === 'other' && data.howFoundOther)   howFoundLabel += ' (' + data.howFoundOther + ')';
  }

  var safetyLabel = '';
  if (data.safetyCheck && data.safetyCheck.length) {
    safetyLabel = data.safetyCheck.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep);
    if (data.safetyNote) safetyLabel += '　' + data.safetyNote;
  } else if (data.safetyNote) {
    safetyLabel = data.safetyNote;
  }

  var dislikedLabel = '';
  if (data.dislikedTreatment && data.dislikedTreatment.length) {
    dislikedLabel = data.dislikedTreatment.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep);
  }

  var mainSymLabel = '—';
  if (data.mainSymptom) {
    var syms = Array.isArray(data.mainSymptom) ? data.mainSymptom : String(data.mainSymptom).split(',');
    mainSymLabel = syms.map(function(s) {
      return s === 'other' && data.mainSymptomOther ? data.mainSymptomOther : (VALUE_LABEL[s] || s);
    }).join('、');
  }

  var painStr = '—';
  if (data.painLevel !== null && data.painLevel !== undefined) {
    var lvl = parseInt(data.painLevel);
    var bar = (lvl >= 1 && lvl <= 10) ? '■'.repeat(lvl) + '□'.repeat(10 - lvl) : '';
    painStr = lvl + ' / 10  ' + bar;
  }

  function rt(text, bold, color) {
    var obj = { type: 'text', text: { content: text } };
    var ann = {};
    if (bold)  ann.bold  = true;
    if (color) ann.color = color;
    if (Object.keys(ann).length) obj.annotations = ann;
    return obj;
  }
  function h2(emoji, title) {
    return { object: 'block', type: 'heading_2', heading_2: { rich_text: [rt(emoji + '  ' + title)] } };
  }
  function div() { return { object: 'block', type: 'divider', divider: {} }; }
  function bul(label, value) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: {
      rich_text: [rt(label + ': ', true), rt(value)]
    }};
  }
  function co(text, icon, color) {
    return { object: 'block', type: 'callout', callout: {
      rich_text: [rt(text)], icon: { type: 'emoji', emoji: icon }, color: color
    }};
  }
  function imgBlock(url) {
    return { object: 'block', type: 'embed', embed: { url: url } };
  }

  var blocks = [];
  var dateStr   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  var visitLabel = data.visitType === 'first' ? '初回来院' : '再診';

  blocks.push(co('問診票　' + dateStr + '　' + visitLabel, '📋', 'blue_background'));
  blocks.push(h2('👤', '基本情報'));
  if (data.name)     blocks.push(bul('氏名', data.name));
  if (data.furigana) blocks.push(bul('フリガナ', data.furigana));
  blocks.push(bul('来院歴', data.visitType === 'first' ? '初回' : '再診'));
  if (data.visitType !== 'first' && data.hasChanges) {
    blocks.push(bul('症状の変化', data.hasChanges === 'yes' ? 'あり（新しい問診あり）' : 'なし'));
  }
  if (data.visitType === 'first' && howFoundLabel) blocks.push(bul('来院のきっかけ', howFoundLabel));
  if (data.dob)   blocks.push(bul('生年月日', data.dob + ageStr));
  if (data.phone) blocks.push(bul('電話番号', data.phone));
  if (data.email) blocks.push(bul('メールアドレス', data.email));
  blocks.push(div());

  blocks.push(h2('🤕', '本日のお悩み'));
  blocks.push(bul('主症状', mainSymLabel));
  if (data.symptomDuration) {
    var durKey = String(data.symptomDuration);
    var durLabel = VALUE_LABEL[durKey] || (durKey.indexOf('other:') === 0 ? durKey.slice(6).trim() : durKey);
    blocks.push(bul('症状の期間', durLabel));
  }
  blocks.push(bul('痛みレベル', painStr));
  blocks.push(div());

  blocks.push(h2('⚠️', '安全確認'));
  if (safetyLabel) {
    blocks.push(co(safetyLabel, '⚠️', 'red_background'));
    if (data.safetyDetail) {
      var sd = data.safetyDetail;
      if (sd.pregnant)      blocks.push(bul('　↳ 妊娠詳細', sd.pregnant));
      if (sd.hospital)      blocks.push(bul('　↳ 通院先', sd.hospital));
      if (sd.blood_thinner) blocks.push(bul('　↳ 薬名', sd.blood_thinner));
      if (sd.numbness)      blocks.push(bul('　↳ しびれ詳細', sd.numbness));
      if (sd.recent_injury) blocks.push(bul('　↳ 怪我・手術', sd.recent_injury));
    }
  } else {
    blocks.push(bul('確認事項', '特になし'));
  }
  if (data.safetyNote) blocks.push(bul('持病・気になること', data.safetyNote));
  blocks.push(div());

  blocks.push(h2('💆', '本日のご希望'));
  if (data.treatmentGoal)     blocks.push(bul('施術目的', VALUE_LABEL[data.treatmentGoal] || data.treatmentGoal));
  if (data.treatmentStrength) blocks.push(bul('強さ希望', VALUE_LABEL[data.treatmentStrength] || data.treatmentStrength));
  if (dislikedLabel)          blocks.push(bul('苦手な施術', dislikedLabel));
  blocks.push(div());

  if (data.photoConsent) {
    blocks.push(h2('📸', '撮影同意'));
    var photoLabel = data.photoConsent === 'yes' ? 'はい（協力可）' : 'いいえ（辞退）';
    blocks.push(bul('撮影協力', photoLabel));
    if (data.photoConsent === 'yes' && data.facePreference) {
      var faceLabel = data.facePreference === 'face_ok' ? '顔出しOK' : '顔は映さないでほしい';
      blocks.push(bul('顔出し', faceLabel));
    }
    blocks.push(div());
  }

  blocks.push(h2('✅', '同意'));
  var consentText = data.consentAgreed ? '✓  同意済み' : '✗  未同意';
  if (data.consentDate) consentText += '（' + data.consentDate + '）';
  blocks.push({ object: 'block', type: 'paragraph', paragraph: {
    rich_text: [rt(consentText, false, data.consentAgreed ? 'green' : 'red')]
  }});

  blocks.push(div());
  blocks.push(h2('🖼', '人体図・署名'));
  if (bodyImageUrl) {
    blocks.push(imgBlock(bodyImageUrl));
  } else {
    blocks.push({ object: 'block', type: 'paragraph', paragraph: {
      rich_text: [rt('未記入', false, 'gray')]
    }});
  }
  blocks.push({ object: 'block', type: 'paragraph', paragraph: {
    rich_text: [rt('署名', true)]
  }});
  if (signatureUrl) {
    blocks.push(imgBlock(signatureUrl));
  } else {
    blocks.push({ object: 'block', type: 'paragraph', paragraph: {
      rich_text: [rt('未記入', false, 'gray')]
    }});
  }

  notionPatch(cfg, '/blocks/' + karteId + '/children', { children: blocks });
}

/* ============================================================
   Google Drive — 人体図・署名保存
   ============================================================ */

function saveBodyImage(cfg, base64DataUrl, prefix, subfolderName) {
  try {
    var match = base64DataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/s);
    if (!match) return '';
    var mimeType = 'image/' + match[1];
    var ext      = match[1] === 'jpeg' ? 'jpg' : match[1];
    var bytes    = Utilities.base64Decode(match[2]);
    var fileName = prefix + '_' + Date.now() + '.' + ext;
    var blob     = Utilities.newBlob(bytes, mimeType, fileName);
    var root     = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);

    // サブフォルダへ振り分け（なければ作成）
    var target = root;
    if (subfolderName) {
      var it = root.getFoldersByName(subfolderName);
      target = it.hasNext() ? it.next() : root.createFolder(subfolderName);
    }

    var file = target.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/file/d/' + file.getId() + '/preview';
  } catch(e) {
    Logger.log('saveBodyImage error: ' + e.message);
    return '';
  }
}

// 既存ファイルをサブフォルダへ整理（手動実行用）
function reorganizeDriveFiles() {
  var cfg = getConfig();
  if (!cfg.DRIVE_FOLDER_ID) { Logger.log('DRIVE_FOLDER_ID 未設定'); return; }

  var root = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);

  // サブフォルダを取得 or 作成
  function getOrCreate(name) {
    var it = root.getFoldersByName(name);
    return it.hasNext() ? it.next() : root.createFolder(name);
  }
  var bodyFolder = getOrCreate('人体図');
  var sigFolder  = getOrCreate('署名');

  var movedBody = 0, movedSig = 0, skipped = 0;
  var files = root.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    // 既にサブフォルダ内のファイルはスキップ（rootの直下のみ対象）
    if (name.indexOf('sig_') === 0 || name.indexOf('body_sig_') === 0) {
      sigFolder.addFile(file);
      root.removeFile(file);
      movedSig++;
    } else if (name.indexOf('body_') === 0) {
      bodyFolder.addFile(file);
      root.removeFile(file);
      movedBody++;
    } else {
      skipped++;
    }
  }

  Logger.log('reorganizeDriveFiles 完了: 人体図=' + movedBody + '件, 署名=' + movedSig + '件, スキップ=' + skipped + '件');
  return { body: movedBody, sig: movedSig, skipped: skipped };
}

/* ============================================================
   メール送信（予約確認）
   ============================================================ */

function sendBookingEmail(cfg, data, patientNum, includeQLink) {
  if (includeQLink === undefined) includeQLink = true;
  try {
    var qLine = '';
    if (includeQLink && (data.visitType === 'first' || data.hasNewSymptom === 'yes')) {
      var siteUrl = cfg.SITE_URL || '';
      if (siteUrl) {
        var qUrl = siteUrl + '/questionnaire.html?lang=' + (data.lang || 'ja')
          + '&name='    + encodeURIComponent(data.name  || '')
          + '&phone='   + encodeURIComponent(data.phone || '')
          + '&email='   + encodeURIComponent(data.email || '')
          + '&booking=' + encodeURIComponent(patientNum)
          + '&visit='   + (data.visitType || 'first');
        qLine = '\n\n■ 問診票\n' + qUrl;
      }
    }
    var tmpl = {
      ja: { subj: '[LBC整体院] 仮予約を受け付けました',         greeting: '様', body1: '仮予約を受け付けました。内容を確認後、担当者よりご連絡いたします。', num: '■ 予約番号', dt: '■ 日時', course: '■ コース' },
      es: { subj: '[LBC Care] Reserva provisional recibida',    greeting: ',',  body1: 'Hemos recibido su reserva provisional. Le confirmaremos a la brevedad.',                   num: '■ N° de reserva',    dt: '■ Fecha y hora', course: '■ Servicio' },
      pt: { subj: '[LBC Care] Agendamento provisório recebido', greeting: ',',  body1: 'Recebemos seu agendamento provisório. Entraremos em contato em breve para confirmar.',      num: '■ N° do agendamento', dt: '■ Data e horário', course: '■ Serviço' },
    };
    var t       = tmpl[data.lang] || tmpl.ja;
    var subject = t.subj + '（' + patientNum + '）';
    var lines   = [
      data.name + ' ' + t.greeting, '',
      t.body1, '',
      t.num    + ': ' + patientNum,
      t.dt     + ': ' + (data.date || '') + ' ' + (data.time || ''),
      t.course + ': ' + (data.courseName || ''),
    ];
    if (qLine) lines.push(qLine);
    lines.push('', '──────────────', 'LBC Care / Lucas Body Care', '〒510-0835 Mie Yokkaichi Ooide', 'TEL: 070-9233-4084');
    MailApp.sendEmail({ to: data.email, subject: subject, body: lines.join('\n') });
  } catch(e) {
    Logger.log('sendBookingEmail error: ' + e.message);
  }
}

/* ============================================================
   コース・ラベルマスタ
   ============================================================ */

var VALID_COURSES = ['カイロプラクティック', '筋膜リリース', '吸い玉・カッピング', 'トータルケア', '月2回コース'];

var COURSE_ID_MAP = {
  'chiro':    'カイロプラクティック',
  'fascia':   '筋膜リリース',
  'cupping':  '吸い玉・カッピング',
  'total':    'トータルケア',
  'monthly2': '月2回コース',
};

var COURSE_NAME_MAP = {
  'カイロプラクティック':    'カイロプラクティック',
  '筋膜リリース':            '筋膜リリース',
  '吸玉（カッピング）':      '吸い玉・カッピング',
  'トータルケア':            'トータルケア',
  'Quiropráctica':           'カイロプラクティック',
  'Liberación Miofascial':   '筋膜リリース',
  'Ventosa':                 '吸い玉・カッピング',
  'Cuidado Total':           'トータルケア',
  'Quiropraxia':             'カイロプラクティック',
  'Liberação Miofascial':    '筋膜リリース',
};

var VALUE_LABEL = {
  instagram: 'Instagram', google: 'Google', google_maps: 'Google Maps',
  referral: '紹介', other: 'その他',
  shoulder_stiff: '肩こり', lower_back: '腰痛', neck_stiff: '首こり', headache: '頭痛',
  posture: '姿勢', fatigue: '疲労', swelling: 'むくみ',
  within_week: '1週間以内', within_month: '1ヶ月以内', over_month: '1ヶ月以上', over_half_year: '半年以上',
  pregnant: '妊娠中／妊娠の可能性', hospital: '通院中', osteoporosis: '骨粗しょう症',
  blood_thinner: '血液をサラサラにする薬', numbness: '強いしびれ', recent_injury: '最近の怪我・手術',
  none: '特になし',
  relax: 'リラックスしたい', pain_relief: '痛みを改善したい',
  posture_goal: '姿勢を整えたい', maintenance: '身体のメンテナンス',
  light: '弱め', normal: '普通', strong: '強め',
  strong_pressure: '強い圧', joint_adjustment: '関節調整（ボキボキ）',
  // 旧フォームキー互換エイリアス
  back_pain: '腰痛', shoulder: '肩こり', neck: '首こり',
  week: '1週間以内', month: '1ヶ月以内', '1_3_months': '1〜3ヶ月',
  medium: '普通',
};

/* ============================================================
   Notion API ヘルパー（ページネーション対応）
   ============================================================ */

function notionHeaders(cfg) {
  return {
    'Authorization':  'Bearer ' + cfg.NOTION_TOKEN,
    'Notion-Version': NOTION_VER,
    'Content-Type':   'application/json',
  };
}

function notionQuery(cfg, dbId, body) {
  var res = UrlFetchApp.fetch(NOTION_API + '/databases/' + dbId + '/query', {
    method: 'post', headers: notionHeaders(cfg),
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

// ページネーション対応: 全件取得
function notionQueryAll(cfg, dbId, filter, sorts) {
  var results = [];
  var cursor  = null;
  do {
    var body = { page_size: 100 };
    if (filter)      body.filter      = filter;
    if (sorts)       body.sorts       = sorts;
    if (cursor)      body.start_cursor = cursor;
    var res  = notionQuery(cfg, dbId, body);
    if (res.results) results = results.concat(res.results);
    cursor   = res.has_more ? res.next_cursor : null;
    if (cursor) Utilities.sleep(350);
  } while (cursor);
  return results;
}

function notionPost(cfg, path, body) {
  var res = UrlFetchApp.fetch(NOTION_API + path, {
    method: 'post', headers: notionHeaders(cfg),
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  var data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) throw new Error('Notion ' + res.getResponseCode() + ': ' + (data.message || data.code || path));
  return data;
}

function notionPatch(cfg, path, body) {
  var res = UrlFetchApp.fetch(NOTION_API + path, {
    method: 'patch', headers: notionHeaders(cfg),
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  var data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) throw new Error('Notion ' + res.getResponseCode() + ': ' + (data.message || data.code || path));
  return data;
}

/* ============================================================
   ユーティリティ（出力系）
   ============================================================ */

function jsonRes(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function richText(content) {
  return { rich_text: [{ type: 'text', text: { content: content || '' } }] };
}

function getTextProp(props, key) {
  var p = props[key];
  if (!p) return '';
  if (p.rich_text) return (p.rich_text[0] && p.rich_text[0].plain_text) || '';
  if (p.title)     return (p.title[0]     && p.title[0].plain_text)     || '';
  return '';
}

/* ============================================================
   テスト・セットアップ関数
   ============================================================ */

// 既存 Notion カルテページのタイトルから P番号プレフィックスを除去する
// 例: "P013 Douglas Silveira (2026/07/31)" → "Douglas Silveira (2026/07/31)"
// GAS エディタから手動で1回実行する
function cleanupKarteTitles() {
  var cfg  = getConfig();
  var url  = NOTION_API + '/databases/' + cfg.KARTE_DB_ID + '/query';
  var renamed = 0;
  var cursor;
  do {
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    var res = notionPost(cfg, '/databases/' + cfg.KARTE_DB_ID + '/query', body);
    var pages = res.results || [];
    for (var i = 0; i < pages.length; i++) {
      var page  = pages[i];
      var props = page.properties || {};
      var titleArr = (props['名前'] && props['名前'].title) || [];
      var current = titleArr.length ? titleArr[0].plain_text : '';
      // P番号プレフィックス "Pnnn " または "Pnnn　" を除去
      var fixed = current.replace(/^P\d{3,4}\s+/, '');
      if (fixed !== current) {
        notionPatch(cfg, '/pages/' + page.id, {
          properties: { '名前': { title: [{ text: { content: fixed } }] } },
        });
        Logger.log('renamed: "' + current + '" → "' + fixed + '"');
        renamed++;
        Utilities.sleep(350);
      }
    }
    cursor = res.next_cursor;
  } while (cursor);
  Logger.log('cleanupKarteTitles 完了: ' + renamed + ' 件リネーム');
}

// テストデータ削除 + 患者番号振り直し（GASエディタから1回だけ手動実行）
function cleanAndRenumber() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  var now = nowISO();
  Logger.log('=== cleanAndRenumber 開始 ===');

  // ── 削除対象: Notion 顧客マスタ ページID ──
  var DEL_CUST = [
    '39b88446-d062-81b2-bb91-c06606ae5225', // 田中 太郎 (旧P001)
    '39b88446-d062-8179-b6c3-e9ae4c58de78', // 鈴木 一郎 (旧P002)
    '39b88446-d062-81a3-b6ea-c83e41478520', // Lucas Silva (旧P003)
    '39b88446-d062-81a9-9b73-d047a81ce68d', // Ana Santos (旧P004)
    '39b88446-d062-8199-872e-d816f13faa6a', // ベントゥーラ ニコラス (旧P005)
    '39b88446-d062-8161-ad1e-d393d683e3dd', // Leonardo Nicolas (旧P006)
    '39b88446-d062-8159-afdd-ffbf2108cff6', // 杉本 ジョエル (旧P007)
    '39b88446-d062-81ce-a1ec-ef6a0f87b813', // レオナルド デカプリオ (旧P008)
    '3af88446-d062-8175-be80-ccfc1e6674b1', // Leonardo Nicolas (テストP001)
    '3af88446-d062-81f7-b3c1-e54f5702a979', // Leonardo Nicolas (テストP002)
    '3af88446-d062-8126-b1e3-f797278a896e', // テスト 花子 (P003)
    '3a988446-d062-81c1-be33-e27d7a1e6b2a', // テスト太郎 (P009)
    '3a988446-d062-816b-bdd0-c9796e13ea5a', // ベントゥーラ ニコラス (P010)
    '3a988446-d062-816d-91ae-d0540c54cdc6', // ベントゥーラニコラス マリカ (P011)
    '3a988446-d062-81c7-be9f-efd8aae0b390', // PedroforoivaJosair Foroiva (P012)
  ];
  // ── 削除対象: Notion 施術カルテ ページID ──
  var DEL_KARTE = [
    '39b88446-d062-810a-beda-dfd2cf34f531', '39b88446-d062-8117-a3ca-d362cc35d0d6',
    '39b88446-d062-8128-b43a-db3aede3f4a2', '39b88446-d062-818e-9d6d-caa6ac67cf65',
    '39b88446-d062-8195-9a22-d69cf0310038', '39b88446-d062-81e0-bdda-f44ad3ed75be',
    '39b88446-d062-81e1-b933-f9c05aeec916', '39b88446-d062-81ee-938d-e73cb193fa3e',
    '3a988446-d062-810d-bbad-c13fed4b309f', '3a988446-d062-811e-947a-e10b7ecacc2b',
    '3a988446-d062-8136-bc7e-d640bea7ebb2', '3a988446-d062-813a-addd-c446dffd31fd',
    '3a988446-d062-8150-a90c-ce9b8dffff94', '3a988446-d062-8155-b7d8-d6fb9e8d76c0',
    '3a988446-d062-8167-83ec-c804f48dbd0b', '3a988446-d062-8171-896e-f1abddc31a01',
    '3a988446-d062-817d-97b7-cb3add6a75cc', '3a988446-d062-8191-9e47-cc79440a3172',
    '3a988446-d062-81ae-9bdd-edc6d9db0311', '3af88446-d062-8123-bfcd-ff854b7c815e',
    '3af88446-d062-8125-9cf4-ff61ec25624a', '3af88446-d062-812c-a57b-c0940e6e38cd',
    '3af88446-d062-814f-8359-c467dc185a0b', '3af88446-d062-81ca-8cc2-cd6a38556d99',
  ];
  // ── 振り直しマップ (旧ID → 新ID) ──
  var RENUMBER = {
    'P013': 'P001', // Yuji Mesquita
    'P014': 'P002', // Amanda Tiemy Hattori
    'P015': 'P003', // Douglas Silveira
    'P016': 'P004', // Kawano Rosas Layla Ketlen
    'P017': 'P005', // José Enrique Vertiz Salazar
  };
  // P004(Dilson) / P005(Alfredo) は同番号に別人がいるため Notion ID で識別
  var DILSON_NID  = '3b088446-d062-81bf-89cd-e3cf2df4e757';
  var ALFREDO_NID = '3b088446-d062-818c-9004-e6025cff22a8';

  // Step 1: Notion ページをアーカイブ
  Logger.log('Step 1: Notion アーカイブ中 (' + (DEL_CUST.length + DEL_KARTE.length) + ' 件)...');
  DEL_CUST.concat(DEL_KARTE).forEach(function(id) {
    try {
      UrlFetchApp.fetch(NOTION_API + '/pages/' + id.replace(/-/g, ''), {
        method: 'patch', headers: notionHeaders(cfg),
        payload: JSON.stringify({ archived: true }), muteHttpExceptions: true,
      });
      Utilities.sleep(200);
    } catch(e) { Logger.log('archive err ' + id + ': ' + e.message); }
  });

  // Step 2: シート行削除ヘルパー (Notion ID マッチ)
  function deleteByNotionId(sheet, col, idSet) {
    if (sheet.getLastRow() < 2) return 0;
    var vals = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
    var delRows = [];
    for (var i = vals.length - 1; i >= 0; i--) {
      if (idSet[String(vals[i][0])]) delRows.push(i + 2);
    }
    delRows.forEach(function(r) { sheet.deleteRow(r); });
    return delRows.length;
  }

  var custIdSet   = {};  DEL_CUST.forEach(function(id)   { custIdSet[id] = true; });
  var karteIdSet  = {};  DEL_KARTE.forEach(function(id)  { karteIdSet[id] = true; });

  // 顧客マスタ: notion_page_id で削除
  var custSheet = ss.getSheetByName('顧客マスタ');
  Logger.log('Step 2a: 顧客マスタ削除 ' + deleteByNotionId(custSheet, CM.notion_page_id, custIdSet) + ' 件');

  // 施術台帳・問診台帳: notion_page_id はカルテ共通
  var trSheet = ss.getSheetByName('施術台帳');
  Logger.log('Step 2b: 施術台帳削除 ' + deleteByNotionId(trSheet, TR.notion_page_id, karteIdSet) + ' 件');
  var quSheet = ss.getSheetByName('問診台帳');
  Logger.log('Step 2c: 問診台帳削除 ' + deleteByNotionId(quSheet, QU.notion_page_id, karteIdSet) + ' 件');

  // クレジット台帳: notion_page_idなし → customer_id で削除
  // 削除確定な顧客ID (P004/P005 は実患者が残るため除外)
  var delCustIds = { P006:1,P007:1,P008:1,P009:1,P010:1,P011:1,P012:1 };
  // P001-P005 はシートの顧客マスタ Notion ID で実患者か判定
  // → クレジット台帳は実患者のクレジットが未付与のため今は空のはず
  var crSheet = ss.getSheetByName('クレジット台帳');
  if (crSheet && crSheet.getLastRow() > 1) {
    var crVals = crSheet.getRange(2, CR.customer_id + 1, crSheet.getLastRow() - 1, 1).getValues();
    var crDel  = [];
    for (var ci = crVals.length - 1; ci >= 0; ci--) {
      if (delCustIds[String(crVals[ci][0])]) crDel.push(ci + 2);
    }
    crDel.forEach(function(r) { crSheet.deleteRow(r); });
    Logger.log('Step 2d: クレジット台帳削除 ' + crDel.length + ' 件');
  }

  // Step 3: 顧客番号振り直し (全シート)
  Logger.log('Step 3: 番号振り直し中...');

  function renumberSheet(sheet, idCol, notionIdCol) {
    if (sheet.getLastRow() < 2) return;
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) {
      var oldId   = String(rows[i][idCol]);
      var notionId = notionIdCol !== null ? String(rows[i][notionIdCol]) : '';
      var newId   = RENUMBER[oldId] || null;
      if (!newId) {
        if (notionId === DILSON_NID  || (oldId === 'P004' && !newId)) newId = 'P006';
        if (notionId === ALFREDO_NID || (oldId === 'P005' && !newId)) newId = 'P007';
      }
      if (newId) {
        sheet.getRange(i + 2, idCol + 1).setValue(newId);
        // updated_at / synced_at リセット（シートごとに列が違う）
        try { sheet.getRange(i + 2, CM.updated_at + 1).setValue(now); } catch(e) {}
        try { sheet.getRange(i + 2, CM.synced_at + 1).setValue(''); } catch(e) {}
      }
    }
  }

  renumberSheet(custSheet, CM.customer_id, CM.notion_page_id);

  // 施術台帳
  if (trSheet && trSheet.getLastRow() > 1) {
    var trRows = trSheet.getRange(2, 1, trSheet.getLastRow() - 1, 18).getValues();
    for (var ti = 0; ti < trRows.length; ti++) {
      var oldCid = String(trRows[ti][TR.customer_id]);
      var newCid = RENUMBER[oldCid]
        || (oldCid === 'P004' ? 'P006' : null)
        || (oldCid === 'P005' ? 'P007' : null);
      if (newCid) {
        trSheet.getRange(ti + 2, TR.customer_id + 1).setValue(newCid);
        trSheet.getRange(ti + 2, TR.updated_at + 1).setValue(now);
        trSheet.getRange(ti + 2, TR.synced_at + 1).setValue('');
      }
    }
  }

  // 問診台帳
  if (quSheet && quSheet.getLastRow() > 1) {
    var quRows = quSheet.getRange(2, 1, quSheet.getLastRow() - 1, 24).getValues();
    for (var qi = 0; qi < quRows.length; qi++) {
      var oldQid = String(quRows[qi][QU.customer_id]);
      var newQid = RENUMBER[oldQid]
        || (oldQid === 'P004' ? 'P006' : null)
        || (oldQid === 'P005' ? 'P007' : null);
      if (newQid) {
        quSheet.getRange(qi + 2, QU.customer_id + 1).setValue(newQid);
        quSheet.getRange(qi + 2, QU.synced_at + 1).setValue('');
      }
    }
  }

  // クレジット台帳
  if (crSheet && crSheet.getLastRow() > 1) {
    var crRows2 = crSheet.getRange(2, 1, crSheet.getLastRow() - 1, 10).getValues();
    for (var ri = 0; ri < crRows2.length; ri++) {
      var oldRid = String(crRows2[ri][CR.customer_id]);
      var newRid = RENUMBER[oldRid]
        || (oldRid === 'P004' ? 'P006' : null)
        || (oldRid === 'P005' ? 'P007' : null);
      if (newRid) crSheet.getRange(ri + 2, CR.customer_id + 1).setValue(newRid);
    }
  }

  // Step 4: 同期カウンタを増やして次回同期を促す
  incSyncCounter(ss, 20);
  Logger.log('=== cleanAndRenumber 完了。次回の同期トリガーで Notion に反映されます ===');
}

// Step 1-2: normalizePhone の動作確認
function testNormalizePhone() {
  var cases = [
    ['090-1234-5678',   '09012345678'],
    ['０９０１２３４５６７８', '09012345678'],
    ['+81 90 1234 5678', '09012345678'],
    ['(090) 1234-5678',  '09012345678'],
    ['09012345678',      '09012345678'],
    ['0752345678',       '0752345678'],
  ];
  var ok = true;
  for (var i = 0; i < cases.length; i++) {
    var input  = cases[i][0];
    var expect = cases[i][1];
    var got    = normalizePhone(input);
    var pass   = got === expect;
    Logger.log((pass ? '✅' : '❌') + ' normalizePhone("' + input + '") = "' + got + '" (expect: "' + expect + '")');
    if (!pass) ok = false;
  }
  Logger.log(ok ? '全テスト PASS' : '❌ テスト FAIL あり');
}

// Step 0.5 セットアップ（再実行可）
function setupStaging() {
  var props = PropertiesService.getScriptProperties();
  var ss    = SpreadsheetApp.create('LBC台帳 [STAGING]');
  var ssId  = ss.getId();
  Logger.log('台帳スプレッドシートID: ' + ssId);
  Logger.log('台帳URL: ' + ss.getUrl());

  ss.getSheets()[0].setName('顧客マスタ');
  ss.insertSheet('施術台帳');
  ss.insertSheet('問診台帳');
  ss.insertSheet('クレジット台帳');
  ss.insertSheet('アクセスログ');
  ss.insertSheet('_sync');

  applySheetHeaders(ss);
  ss.getSheetByName('_sync').getRange('A1').setValue(0);

  props.setProperties({
    'ENV':                           'staging',
    'NOTIFY_EMAIL':                  'kakimorilucas@gmail.com',
    'STAGING_CUSTOMER_DB_ID':        '3af88446-d062-812c-998a-ef68015d5ea5',
    'STAGING_KARTE_DB_ID':           '3af88446-d062-81e9-80bc-cbd8d9bc39b9',
    'STAGING_LEDGER_SPREADSHEET_ID': ssId,
  }, true);

  Logger.log('✅ ステージング環境セットアップ完了！ ID: ' + ssId);
}

// GASエディタから手動実行: installTriggers の動作確認
function setupTriggers() {
  installTriggers();
}

// スタッフパスワード設定（GASエディタから手動実行）— 例: setStaffPassword('my_secure_password')
function setStaffPassword(pw) {
  if (!pw || pw.length < 4) { Logger.log('❌ パスワードが短すぎます（4文字以上必要）'); return; }
  PropertiesService.getScriptProperties().setProperty('STAFF_PASSWORD', pw);
  Logger.log('✅ STAFF_PASSWORD を設定しました');
}

// 本番環境セットアップ（GASエディタから手動実行）
// 前提: CUSTOMER_DB_ID / KARTE_DB_ID / NOTION_TOKEN / STAFF_PASSWORD / NOTIFY_EMAIL を先に設定
function setupProduction() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty('LEDGER_SPREADSHEET_ID');
  if (existingId) {
    Logger.log('⚠️  本番台帳 ID はすでに設定済みです: ' + existingId + ' — 続けますか？上書きするには既存行を削除してください。');
    return;
  }

  var ss   = SpreadsheetApp.create('LBC台帳 [本番]');
  var ssId = ss.getId();
  Logger.log('台帳スプレッドシートID: ' + ssId);
  Logger.log('台帳URL: ' + ss.getUrl());

  ss.getSheets()[0].setName('顧客マスタ');
  ss.insertSheet('施術台帳');
  ss.insertSheet('問診台帳');
  ss.insertSheet('クレジット台帳');
  ss.insertSheet('アクセスログ');
  ss.insertSheet('_sync');

  applySheetHeaders(ss);
  ss.getSheetByName('_sync').getRange('A1').setValue(0);

  props.setProperty('ENV', 'production');
  props.setProperty('LEDGER_SPREADSHEET_ID', ssId);

  installTriggers();
  Logger.log('✅ 本番環境セットアップ完了！ ID: ' + ssId);
  Logger.log('台帳URL: ' + ss.getUrl());
  Logger.log('次のステップ: 問診票・施術記録シートで本番疎通確認を行ってください。');
}

/* ============================================================
   本番プロパティ復元（setupProduction後にプロパティが消えた場合）
   GASエディタから手動実行する。NOTION_TOKEN と STAFF_PASSWORD は
   別途スクリプトプロパティ画面で手動入力すること。
   ============================================================ */
function recoverProductionProperties() {
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperties();

  // 既存値を保持したまま、消えた値だけ補完する
  var toSet = {};

  if (!current.CUSTOMER_DB_ID)
    toSet.CUSTOMER_DB_ID = 'bafca368-66c7-4bb7-8129-65c2e966cd51';
  if (!current.KARTE_DB_ID)
    toSet.KARTE_DB_ID = '1fe16e73-6413-44d5-ba61-a56cd235b7b5';
  if (!current.STAGING_CUSTOMER_DB_ID)
    toSet.STAGING_CUSTOMER_DB_ID = '3af88446-d062-812c-998a-ef68015d5ea5';
  if (!current.SITE_URL)
    toSet.SITE_URL = 'https://nicolas2028-data.github.io/lbc-form';
  if (!current.NOTIFY_EMAIL)
    toSet.NOTIFY_EMAIL = 'v.nico2003@gmail.com';

  if (Object.keys(toSet).length > 0) {
    props.setProperties(toSet);
    Logger.log('✅ 復元完了: ' + JSON.stringify(Object.keys(toSet)));
  } else {
    Logger.log('ℹ️ 復元不要: 全プロパティが既に存在します');
  }

  Logger.log('--- 現在の設定状態 ---');
  var c = props.getProperties();
  Logger.log('ENV: '                    + (c.ENV || '(未設定)'));
  Logger.log('LEDGER_SPREADSHEET_ID: ' + (c.LEDGER_SPREADSHEET_ID || '(未設定)'));
  Logger.log('CUSTOMER_DB_ID: '        + (c.CUSTOMER_DB_ID || '(未設定)'));
  Logger.log('KARTE_DB_ID: '           + (c.KARTE_DB_ID || '(未設定)'));
  Logger.log('NOTION_TOKEN: '          + (c.NOTION_TOKEN ? '✅ 設定済み' : '❌ 要手動入力'));
  Logger.log('STAFF_PASSWORD: '        + (c.STAFF_PASSWORD ? '✅ 設定済み' : '❌ 要手動入力'));
  Logger.log('NOTIFY_EMAIL: '          + (c.NOTIFY_EMAIL || '(未設定)'));
  Logger.log('DRIVE_FOLDER_ID: '       + (c.DRIVE_FOLDER_ID ? '✅ 設定済み' : '⚠️ 未設定（人体図機能に必要）'));
  Logger.log('STAGING_CUSTOMER_DB_ID: '+ (c.STAGING_CUSTOMER_DB_ID || '(未設定)'));
}

/* ============================================================
   シートヘッダー定義（カラム名・色分け）
   ============================================================ */

var SHEET_DEFS = {
  '顧客マスタ': {
    headers: ['診察番号','氏名','フリガナ','電話番号','メールアドレス','生年月日','初回来院日','言語','来院のきっかけ','住所','ステータス','[Notion ID]','[登録日時]','[更新日時]','[同期日時]'],
    systemFrom: 11, // index 11以降がシステム列
  },
  '施術台帳': {
    headers: ['記録ID','種別','対象記録ID','施術日','診察番号','コース','売上金額','支払方法','施術メモ','問診票あり','クレジット使用額','紹介者診察番号','集計対象','[Notion ID]','[登録日時]','[更新日時]','[同期日時]','[エラー回数]'],
    systemFrom: 13,
  },
  '問診台帳': {
    headers: ['問診ID','施術日','診察番号','来院区分','前回から変化あり','主症状','症状期間','痛みレベル','安全確認','安全確認メモ','施術目的','強さ希望','苦手な施術','撮影同意','顔出し希望','同意済み','同意日時','人体図URL','署名URL','[Notion ID]','[登録日時]','[同期日時]','[エラー回数]','[問診JSON]'],
    systemFrom: 19,
  },
  'クレジット台帳': {
    headers: ['記録ID','日付','診察番号','種別','金額','有効期限','関連記録ID','[登録日時]','[同期日時]','[エラー回数]'],
    systemFrom: 7,
  },
  'アクセスログ': {
    headers: ['日時','操作','リクエストID','結果','エラー概要','処理時間(ms)','診察番号(参考)'],
    systemFrom: 0, // 全列システム
  },
};

// ヘッダー設定 + 色分けを指定シートに適用
function applySheetHeaders(ss) {
  Object.keys(SHEET_DEFS).forEach(function(name) {
    var sh  = ss.getSheetByName(name);
    if (!sh) return;
    var def = SHEET_DEFS[name];
    var len = def.headers.length;
    sh.getRange(1, 1, 1, len).setValues([def.headers]);
    sh.setFrozenRows(1);
    // ユーザー列：青
    if (def.systemFrom > 0) {
      sh.getRange(1, 1, 1, def.systemFrom)
        .setFontWeight('bold').setBackground('#e8f0fe').setFontColor('#1a1a1a');
    }
    // システム列：グレー
    var sysLen = len - def.systemFrom;
    if (sysLen > 0) {
      sh.getRange(1, def.systemFrom + 1, 1, sysLen)
        .setFontWeight('bold').setBackground('#eeeeee').setFontColor('#888888');
    }
    // 顧客マスタの電話番号列をテキスト形式に（先頭0を保護）
    if (name === '顧客マスタ') {
      sh.getRange(2, CM.phone + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    }
  });
}

// 既存台帳にヘッダーと色分けを適用（手動実行用）
function reformatSheets() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  applySheetHeaders(ss);
  Logger.log('✅ シートヘッダー更新完了');
}

// 顧客マスタの電話番号先頭0を一括補完して再同期対象にする（一回だけ手動実行）
function fixExistingPhones(cfg) {
  cfg       = cfg || getConfig();
  var ss    = getLedger(cfg);
  var sheet = ss.getSheetByName('顧客マスタ');
  if (sheet.getLastRow() < 2) { Logger.log('データなし'); return; }
  // まず電話番号列をテキスト形式に設定（先頭0保護）
  sheet.getRange(2, CM.phone + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  var rows  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 15).getValues();
  var fixed = 0;
  rows.forEach(function(r, i) {
    var phone = String(r[CM.phone] || '');
    var norm  = normalizePhone(phone);
    if (norm && norm !== phone) {
      var row = i + 2;
      sheet.getRange(row, CM.phone + 1).setValue(norm);
      sheet.getRange(row, CM.synced_at + 1).setValue(''); // 再同期
      Logger.log('row ' + row + ': ' + phone + ' → ' + norm);
      fixed++;
    }
  });
  if (fixed > 0) incSyncCounter(ss, fixed);
  Logger.log('✅ fixExistingPhones 完了: ' + fixed + '件修正');
}

// ステージング用 Drive フォルダを作成して DRIVE_FOLDER_ID を設定
function setupDriveFolder() {
  var folder = DriveApp.createFolder('LBC 人体図 [STAGING]');
  var folderId = folder.getId();
  PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', folderId);
  Logger.log('✅ DRIVE_FOLDER_ID 設定完了: ' + folderId);
  Logger.log('フォルダURL: ' + folder.getUrl());
}

// ステージング環境の一括セットアップ（Drive フォルダ作成 → リセット → 同期）
function setupAll() {
  var props = PropertiesService.getScriptProperties().getProperties();

  // 1. Drive フォルダ作成（未設定の場合のみ）
  if (!props.DRIVE_FOLDER_ID) {
    var folder = DriveApp.createFolder('LBC 人体図 [STAGING]');
    PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', folder.getId());
    Logger.log('✅ Drive フォルダ作成: ' + folder.getId());
    Logger.log('   URL: ' + folder.getUrl());
  } else {
    Logger.log('✅ Drive フォルダ設定済み: ' + props.DRIVE_FOLDER_ID);
  }

  // 2. 詰まっている行をリセット（notion_page_id なし & synced_at 有 or error_count > 0）
  resetOrphanedSyncedAt();

  // 3. 同期実行
  syncToNotion();

  Logger.log('');
  Logger.log('=== setupAll 完了 ===');
  Logger.log('次のステップ: 以下URLで問診票を再送信して画像付きの動作を確認');
  Logger.log('https://nicolas2028-data.github.io/lbc-form/questionnaire.html?env=staging');
}

// notion_page_id が空なのに synced_at が入っている行を再同期対象にリセット
function resetOrphanedSyncedAt() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  var fixed = 0;

  // 顧客マスタ
  var cmSheet = ss.getSheetByName('顧客マスタ');
  if (cmSheet.getLastRow() > 1) {
    var cmRows = cmSheet.getRange(2, 1, cmSheet.getLastRow() - 1, 15).getValues();
    cmRows.forEach(function(r, i) {
      if (!r[CM.notion_page_id] && r[CM.synced_at]) {
        cmSheet.getRange(i + 2, CM.synced_at + 1).setValue('');
        fixed++;
        Logger.log('CM reset row ' + (i+2) + ': ' + r[CM.customer_id]);
      }
    });
  }

  // 問診台帳
  var quSheet = ss.getSheetByName('問診台帳');
  if (quSheet.getLastRow() > 1) {
    var quRows = quSheet.getRange(2, 1, quSheet.getLastRow() - 1, 24).getValues();
    quRows.forEach(function(r, i) {
      if (!r[QU.notion_page_id]) {
        quSheet.getRange(i + 2, QU.synced_at + 1).setValue('');
        quSheet.getRange(i + 2, QU.error_count + 1).setValue(0);
        fixed++;
        Logger.log('QU reset row ' + (i+2) + ': ' + r[QU.entry_id]);
      }
    });
  }

  // 施術台帳
  var trSheet = ss.getSheetByName('施術台帳');
  if (trSheet.getLastRow() > 1) {
    var trRows = trSheet.getRange(2, 1, trSheet.getLastRow() - 1, 18).getValues();
    trRows.forEach(function(r, i) {
      if (!r[TR.notion_page_id]) {
        trSheet.getRange(i + 2, TR.synced_at + 1).setValue('');
        trSheet.getRange(i + 2, TR.error_count + 1).setValue(0);
        fixed++;
        Logger.log('TR reset row ' + (i+2) + ': ' + r[TR.entry_id]);
      }
    });
  }

  if (fixed > 0) incSyncCounter(ss, fixed);
  Logger.log('resetOrphanedSyncedAt: ' + fixed + ' 行をリセットしました');
}

// 顧客マスタ1行目だけ同期テスト（詳細ログ付き）
function debugSyncOneCustomer() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);
  var sheet = ss.getSheetByName('顧客マスタ');
  if (sheet.getLastRow() < 2) { Logger.log('データなし'); return; }
  var r = sheet.getRange(2, 1, 1, 15).getValues()[0];
  Logger.log('row: ' + JSON.stringify(r));

  var langMap = { ja: 'ja', es: 'es', pt: 'pt' };
  var props = {
    '名前':          { title: [{ text: { content: String(r[CM.name]) } }] },
    'フリガナ':       richText(String(r[CM.furigana])),
    '電話番号':       { phone_number: String(r[CM.phone]) || null },
    'メールアドレス': { email: String(r[CM.email]) || null },
    '診察番号':       richText(String(r[CM.customer_id])),
    '言語':           { select: langMap[String(r[CM.lang])] ? { name: String(r[CM.lang]) } : null },
  };
  Logger.log('props: ' + JSON.stringify(props));

  var res = UrlFetchApp.fetch(NOTION_API + '/pages', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + cfg.NOTION_TOKEN,
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({ parent: { database_id: cfg.CUSTOMER_DB_ID }, properties: props }),
    muteHttpExceptions: true,
  });
  Logger.log('status: ' + res.getResponseCode());
  Logger.log('response: ' + res.getContentText().slice(0, 800));
}

// ブルートフォースロック解除（GASエディタから手動実行用）
function clearAuthLock() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('bf_staff_staging');
  props.deleteProperty('bf_staff_production');
  Logger.log('✅ bf_staff クリア完了');
}

// Notion API疎通確認 + シート状態確認
function debugSync() {
  var cfg = getConfig();
  Logger.log('ENV: ' + cfg._env);
  Logger.log('LEDGER_SPREADSHEET_ID: ' + cfg.LEDGER_SPREADSHEET_ID);
  Logger.log('CUSTOMER_DB_ID: ' + cfg.CUSTOMER_DB_ID);
  Logger.log('KARTE_DB_ID: ' + cfg.KARTE_DB_ID);

  var ss = getLedger(cfg);

  // 顧客マスタの行内容を確認
  var cmSheet = ss.getSheetByName('顧客マスタ');
  var cmLast = cmSheet.getLastRow();
  Logger.log('顧客マスタ lastRow: ' + cmLast);
  if (cmLast > 1) {
    var cmRows = cmSheet.getRange(2, 1, cmLast - 1, 15).getValues();
    cmRows.forEach(function(r, i) {
      Logger.log('CM row' + (i+2) + ': customer_id=' + r[CM.customer_id]
        + ', updated_at=' + r[CM.updated_at]
        + ', synced_at=[' + r[CM.synced_at] + ']'
        + ', notion_page_id=[' + r[CM.notion_page_id] + ']');
    });
  }

  // 問診台帳の行内容を確認
  var quSheet = ss.getSheetByName('問診台帳');
  var quLast = quSheet.getLastRow();
  Logger.log('問診台帳 lastRow: ' + quLast);
  if (quLast > 1) {
    var quRows = quSheet.getRange(2, 1, quLast - 1, 24).getValues();
    quRows.forEach(function(r, i) {
      Logger.log('QU row' + (i+2) + ': entry_id=' + r[QU.entry_id]
        + ', synced_at=[' + r[QU.synced_at] + ']'
        + ', notion_page_id=[' + r[QU.notion_page_id] + ']');
    });
  }

  // Notion API テスト: 顧客DBにページ作成テスト
  Logger.log('--- Notion page create test ---');
  try {
    var testProps = {
      '名前': { title: [{ text: { content: 'debugTest' } }] },
    };
    var res = UrlFetchApp.fetch(NOTION_API + '/pages', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + cfg.NOTION_TOKEN,
        'Notion-Version': NOTION_VER,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ parent: { database_id: cfg.CUSTOMER_DB_ID }, properties: testProps }),
      muteHttpExceptions: true,
    });
    Logger.log('create status: ' + res.getResponseCode());
    Logger.log('create response: ' + res.getContentText().slice(0, 400));
  } catch(e) {
    Logger.log('create error: ' + e.message);
  }
}

// ============================================================
// diagSheets: 各タブの行数とcustomer_idの種類を一覧表示（デバッグ用）
// ============================================================
function diagSheets() {
  var ss = getLedger(getConfig());
  var TABS = [
    ['顧客マスタ',    CM.customer_id],
    ['施術台帳',      TR.customer_id],
    ['問診台帳',      QU.customer_id],
    ['クレジット台帳', CR.customer_id],
  ];
  TABS.forEach(function(pair) {
    var tabName = pair[0], colIdx = pair[1];
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) { Logger.log(tabName + ': シートなし'); return; }
    var lastRow = sheet.getLastRow();
    Logger.log(tabName + ': lastRow=' + lastRow);
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, Math.max(colIdx + 1, 3)).getValues();
    var ids = {};
    data.forEach(function(row) {
      var id = String(row[colIdx]).trim();
      ids[id] = (ids[id] || 0) + 1;
    });
    Logger.log(tabName + ' IDs: ' + JSON.stringify(ids));
  });
}

// ============================================================
// deleteTestRows: P001〜P007 以外の行を全タブから削除する
// GAS エディタから手動実行（一回限り）
// ============================================================
function deleteTestRows() {
  var REAL_IDS = ['P001', 'P002', 'P003', 'P004', 'P005', 'P006', 'P007'];
  var ss = getLedger(getConfig());

  // [タブ名, customer_id列インデックス(0始まり)]
  var TABS = [
    ['顧客マスタ',  CM.customer_id],
    ['施術台帳',    TR.customer_id],
    ['問診台帳',    QU.customer_id],
    ['クレジット台帳', CR.customer_id],
  ];

  TABS.forEach(function(pair) {
    var tabName = pair[0];
    var colIdx  = pair[1];
    var sheet   = ss.getSheetByName(tabName);
    if (!sheet) { Logger.log(tabName + ': シートなし'); return; }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log(tabName + ': データなし'); return; }

    var data = sheet.getRange(2, colIdx + 1, lastRow - 1, 1).getValues();
    var toDelete = [];
    for (var i = data.length - 1; i >= 0; i--) {
      var id = String(data[i][0]).trim();
      if (id && REAL_IDS.indexOf(id) === -1) {
        toDelete.push(i + 2); // 1始まり行番号
      }
    }

    Logger.log(tabName + ': ' + toDelete.length + ' 行削除');
    toDelete.forEach(function(rowNum) {
      sheet.deleteRow(rowNum);
    });
  });

  Logger.log('=== deleteTestRows 完了 ===');
}

/* ============================================================
   テスト: 月2回プラン2回目検出ロジック
   ============================================================ */
function testMonthly2Detection() {
  var curMonth = todayStr().slice(0, 7);
  var custId   = 'TEST_C001';

  // makeRow でテスト行を作成するヘルパー
  function makeTestRow(overrides) {
    var row = new Array(18).fill('');
    for (var k in overrides) row[k] = overrides[k];
    return row;
  }

  // 共通フィールド
  var base = {
    [TR.customer_id]: custId,
    [TR.type]:        'record',
    [TR.course]:      '月2回コース',
    [TR.date]:        curMonth + '-01',
    [TR.entry_id]:    'E001',
  };

  function detectM2(treatRows) {
    var voidedIds = {};
    var m2First = 0, m2Second = 0;
    for (var m = 0; m < treatRows.length; m++) {
      var mr = treatRows[m];
      if (String(mr[TR.customer_id]) !== custId) continue;
      if (String(mr[TR.type]) !== 'record') continue;
      if (voidedIds[String(mr[TR.entry_id])]) continue;
      if (toDateStr(mr[TR.date]).slice(0, 7) !== curMonth) continue;
      if (String(mr[TR.course]) === '月2回コース') {
        if (Number(mr[TR.sales]) > 0) m2First++;
        else m2Second++;
      }
    }
    return { m2First: m2First, m2Second: m2Second, monthly2Available: m2First > m2Second };
  }

  // シナリオ1: 当月に月2回コース記録なし → false
  var s1 = detectM2([]);
  Logger.log('[S1] 記録なし → monthly2Available=' + s1.monthly2Available + ' (期待: false)');

  // シナリオ2: 当月に1回目(sales=10000)のみ → true
  var row1 = makeTestRow(Object.assign({}, base, { [TR.sales]: 10000, [TR.entry_id]: 'E001' }));
  var s2 = detectM2([row1]);
  Logger.log('[S2] 1回目のみ → monthly2Available=' + s2.monthly2Available + ' m2First=' + s2.m2First + ' (期待: true)');

  // シナリオ3: 当月に1回目+2回目(sales=0)の両方 → false（2回目済み）
  var row2 = makeTestRow(Object.assign({}, base, { [TR.sales]: 0, [TR.entry_id]: 'E002' }));
  var s3 = detectM2([row1, row2]);
  Logger.log('[S3] 1回目+2回目済み → monthly2Available=' + s3.monthly2Available + ' (期待: false)');

  // シナリオ4: 先月の1回目+当月なし → false（月をまたぐ）
  var rowPrev = makeTestRow(Object.assign({}, base, {
    [TR.sales]:   10000,
    [TR.date]:    '2026-07-01',
    [TR.entry_id]: 'E003',
  }));
  var s4 = detectM2([rowPrev]);
  Logger.log('[S4] 先月の1回目のみ → monthly2Available=' + s4.monthly2Available + ' (期待: false)');

  // シナリオ5: 1回目がvoid済み → false（取消されている）
  var voidedBase = {};
  voidedBase[TR.customer_id] = custId;
  voidedBase[TR.type] = 'void';
  voidedBase[TR.entry_id] = 'V001';
  voidedBase[TR.date] = curMonth + '-01';
  var rowVoid = makeTestRow(voidedBase);

  // void処理込みで再確認（voidedIds付き）
  function detectM2WithVoid(treatRows, voidTargetId) {
    var voidedIds = {};
    voidedIds[voidTargetId] = true;
    var m2First = 0, m2Second = 0;
    for (var m = 0; m < treatRows.length; m++) {
      var mr = treatRows[m];
      if (String(mr[TR.customer_id]) !== custId) continue;
      if (String(mr[TR.type]) !== 'record') continue;
      if (voidedIds[String(mr[TR.entry_id])]) continue;
      if (toDateStr(mr[TR.date]).slice(0, 7) !== curMonth) continue;
      if (String(mr[TR.course]) === '月2回コース') {
        if (Number(mr[TR.sales]) > 0) m2First++;
        else m2Second++;
      }
    }
    return { m2First: m2First, m2Second: m2Second, monthly2Available: m2First > m2Second };
  }
  var s5 = detectM2WithVoid([row1], 'E001');
  Logger.log('[S5] 1回目がvoid済み → monthly2Available=' + s5.monthly2Available + ' (期待: false)');

  Logger.log('=== testMonthly2Detection 完了 ===');
}

/* ============================================================
   ダッシュボード集計APIハンドラー
   ============================================================ */
function handleGetDashboardData(cfg) {
  // 顧客マスタ: pageId → 初回訪問月(YYYY-MM)
  var custPages = notionQueryAll(cfg, cfg.CUSTOMER_DB_ID, null, null);
  var firstVisitMap = {};
  custPages.forEach(function(page) {
    var d = page.properties['初回訪問日'];
    var start = d && d.date && d.date.start;
    if (start) firstVisitMap[page.id] = start.slice(0, 7);
  });

  // 施術カルテ: 全ページ取得して集計
  var kartePages = notionQueryAll(cfg, cfg.KARTE_DB_ID, null, null);

  var visits        = {}; // { 'YYYY-MM': { newKeys:{}, retKeys:{} } }
  var sales         = {}; // { 'YYYY-MM': number }
  var courses       = {}; // { コース名: count }
  var payments      = {}; // { 支払い方法: count }
  var totalSalesSum = 0;
  var recordedCount = 0;

  kartePages.forEach(function(page) {
    var props = page.properties;

    var dateVal = props['日付'];
    var dateStr = dateVal && dateVal.date && dateVal.date.start;
    if (!dateStr) return;
    var ym = dateStr.slice(0, 7);

    var salesProp = props['売上金額'];
    var amount    = (salesProp && salesProp.number != null) ? salesProp.number : null;

    if (amount != null) {
      sales[ym]    = (sales[ym] || 0) + amount;
      totalSalesSum += amount;
      recordedCount++;

      var cn = (props['コース'] && props['コース'].select) ? props['コース'].select.name : '未記入';
      courses[cn] = (courses[cn] || 0) + 1;

      var pn = (props['支払い方法'] && props['支払い方法'].select) ? props['支払い方法'].select.name : '未記入';
      payments[pn] = (payments[pn] || 0) + 1;
    } else {
      if (!sales[ym]) sales[ym] = 0;
    }

    if (!visits[ym]) visits[ym] = { newKeys: {}, retKeys: {} };
    var rel    = props['顧客マスタ'];
    var relIds = rel && rel.relation ? rel.relation.map(function(r) { return r.id; }) : [];
    var custId = relIds[0] || '';
    var fvYm   = custId ? (firstVisitMap[custId] || '') : '';
    var isNew  = fvYm && fvYm === ym;
    if (isNew) visits[ym].newKeys[page.id] = 1;
    else       visits[ym].retKeys[page.id]  = 1;
  });

  var allYm  = Object.keys(Object.assign({}, visits, sales)).sort();
  var result = {
    months:        allYm,
    newVisits:     allYm.map(function(ym) { return visits[ym] ? Object.keys(visits[ym].newKeys).length : 0; }),
    retVisits:     allYm.map(function(ym) { return visits[ym] ? Object.keys(visits[ym].retKeys).length : 0; }),
    sales:         allYm.map(function(ym) { return Math.round(sales[ym] || 0); }),
    courses:       courses,
    payments:      payments,
    totalSales:    Math.round(totalSalesSum),
    recordedCount: recordedCount,
    totalVisits:   allYm.reduce(function(acc, ym) {
      return acc + (visits[ym] ? Object.keys(visits[ym].newKeys).length + Object.keys(visits[ym].retKeys).length : 0);
    }, 0),
    updatedAt:     new Date().toISOString()
  };

  var output = ContentService.createTextOutput(JSON.stringify(result));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/* ============================================================
   ダッシュボード（Googleスプレッドシートグラフ）
   GASエディタから手動実行: createDashboard()
   ============================================================ */
function createDashboard() {
  var cfg = getConfig();
  var ss  = getLedger(cfg);

  // ── データ読み込み ──────────────────────────────────
  var trRows = getSheetData(ss, '施術台帳');
  var cmRows = getSheetData(ss, '顧客マスタ');

  // 顧客ID → 初回来院月(YYYY-MM) マップ
  var firstVisitMonthMap = {};
  cmRows.forEach(function(row) {
    var cid = String(row[CM.customer_id] || '').trim();
    var fv  = toDateStr(row[CM.first_visit]);
    if (cid && fv) firstVisitMonthMap[cid] = fv.slice(0, 7);
  });

  // ── 月別集計 ────────────────────────────────────────
  // visits: { 'YYYY-MM': { newKeys: Set, retKeys: Set } }
  // sales:  { 'YYYY-MM': number }
  var visits = {};
  var sales  = {};

  trRows.forEach(function(row) {
    var dateStr = toDateStr(row[TR.date]);
    var cid     = String(row[TR.customer_id] || '').trim();
    var amount  = parseFloat(row[TR.sales]) || 0;
    var eligible = row[TR.count_eligible];
    if (!dateStr || !cid) return;

    var ym = dateStr.slice(0, 7); // YYYY-MM

    // 月別売上: voidの負数が自動相殺されるため全行対象
    sales[ym] = (sales[ym] || 0) + amount;

    // 月別来院数: 集計対象=TRUE の行のみ
    var isEligible = (eligible === true || String(eligible).toUpperCase() === 'TRUE');
    if (!isEligible) return;

    if (!visits[ym]) visits[ym] = { newKeys: {}, retKeys: {} };
    var key = dateStr + '_' + cid;
    var isNew = (firstVisitMonthMap[cid] === ym);
    if (isNew) visits[ym].newKeys[key] = 1;
    else       visits[ym].retKeys[key] = 1;
  });

  // 全月を昇順ソート
  var allYm = Object.keys(Object.assign({}, visits, sales)).sort();
  if (allYm.length === 0) {
    Logger.log('データがありません。施術台帳を確認してください。');
    return;
  }

  // ── 集計シート作成/更新 ─────────────────────────────
  var dashSheet = ss.getSheetByName('集計');
  if (!dashSheet) dashSheet = ss.insertSheet('集計');
  dashSheet.clearContents();
  dashSheet.clearFormats();
  dashSheet.getCharts().forEach(function(c) { dashSheet.removeChart(c); });

  // 来院データ (A列〜D列): 年月 / 新規 / 既存 / 合計
  var visitHeader = [['年月', '新規', '既存', '来院数合計']];
  var visitRows = allYm.map(function(ym) {
    var v   = visits[ym] || { newKeys: {}, retKeys: {} };
    var nw  = Object.keys(v.newKeys).length;
    var ret = Object.keys(v.retKeys).length;
    return [ym, nw, ret, nw + ret];
  });

  // 売上データ (F列〜G列): 年月 / 売上
  var salesHeader = [['年月', '売上（円）']];
  var salesRows = allYm.map(function(ym) {
    return [ym, Math.round(sales[ym] || 0)];
  });

  var n = allYm.length;
  dashSheet.getRange(1, 1, 1, 4).setValues(visitHeader);
  dashSheet.getRange(2, 1, n, 4).setValues(visitRows);
  dashSheet.getRange(1, 6, 1, 2).setValues(salesHeader);
  dashSheet.getRange(2, 6, n, 2).setValues(salesRows);

  // ヘッダー装飾
  var headerBg = '#0B2B26', headerFg = '#ffffff';
  dashSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground(headerBg).setFontColor(headerFg);
  dashSheet.getRange(1, 6, 1, 2).setFontWeight('bold').setBackground(headerBg).setFontColor(headerFg);
  dashSheet.autoResizeColumns(1, 7);

  // ── グラフ作成 ──────────────────────────────────────
  var ssId = ss.getId();

  // グラフ①: 月別来院数（棒グラフ）
  var chart1 = dashSheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dashSheet.getRange(1, 1, n + 1, 1))
    .addRange(dashSheet.getRange(1, 4, n + 1, 1))
    .setOption('title', '月別来院数')
    .setOption('hAxis.title', '年月')
    .setOption('vAxis.title', '来院数')
    .setOption('vAxis.minValue', 0)
    .setOption('colors', ['#2C7A5C'])
    .setOption('legend.position', 'none')
    .setPosition(1, 9, 10, 10)
    .build();
  dashSheet.insertChart(chart1);

  // グラフ②: 月別売上（棒グラフ）
  var chart2 = dashSheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dashSheet.getRange(1, 6, n + 1, 2))
    .setOption('title', '月別売上（円）')
    .setOption('hAxis.title', '年月')
    .setOption('vAxis.title', '売上（円）')
    .setOption('vAxis.minValue', 0)
    .setOption('colors', ['#163832'])
    .setOption('legend.position', 'none')
    .setPosition(22, 9, 10, 10)
    .build();
  dashSheet.insertChart(chart2);

  // グラフ③: 新規・既存内訳（積み上げ棒グラフ）
  var chart3 = dashSheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dashSheet.getRange(1, 1, n + 1, 1))
    .addRange(dashSheet.getRange(1, 2, n + 1, 2))
    .setOption('title', '新規・既存内訳')
    .setOption('hAxis.title', '年月')
    .setOption('vAxis.title', '来院数')
    .setOption('vAxis.minValue', 0)
    .setOption('isStacked', true)
    .setOption('colors', ['#2C7A5C', '#8BC4A8'])
    .setPosition(43, 9, 10, 10)
    .build();
  dashSheet.insertChart(chart3);

  // ── 埋め込みURL出力 ─────────────────────────────────
  var charts = dashSheet.getCharts();
  Logger.log('=== ダッシュボード作成完了 ===');
  Logger.log('集計シートURL: https://docs.google.com/spreadsheets/d/' + ssId + '/edit#gid=' + dashSheet.getSheetId());
  Logger.log('');
  Logger.log('【Notion埋め込み用URL】');
  Logger.log('※ スプレッドシートを「ウェブに公開」してから使用してください');
  charts.forEach(function(c, i) {
    var labels = ['月別来院数', '月別売上', '新規・既存内訳'];
    Logger.log((labels[i] || 'グラフ' + (i+1)) + ': https://docs.google.com/spreadsheets/d/' + ssId + '/pubchart?oid=' + c.getChartId() + '&format=interactive');
  });
  Logger.log('');
  Logger.log('【ウェブ公開手順】');
  Logger.log('スプレッドシート → ファイル → ウェブに公開 → シート「集計」を選択 → 公開');
}
