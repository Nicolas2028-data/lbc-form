/* ============================================================
   LBC Care — Google Apps Script バックエンド
   ============================================================
   【スクリプトプロパティに設定が必要な値】
   NOTION_TOKEN    : Notion API トークン（ntn_...）
   CUSTOMER_DB_ID  : 顧客マスタ DB → bafca368-66c7-4bb7-8129-65c2e966cd51
   KARTE_DB_ID     : 施術カルテ DB → 1fe16e73-6413-44d5-ba61-a56cd235b7b5
   DRIVE_FOLDER_ID : 人体図画像保存先 Google Drive フォルダ ID → 1wbZ-dYw7doDdPk0mYHR-jLfJJL3JCgNk
   STAFF_PASSWORD  : スタッフモードのパスワード
   SITE_URL        : フォームの公開URL → https://nicolas2028-data.github.io/lbc-form
   ============================================================ */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

/* ── エントリポイント ── */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'lookupPatient')       return jsonRes(handleLookupPatient(data));
    if (data.action === 'submitBooking')       return jsonRes(handleSubmitBooking(data));
    if (data.action === 'submitAll')           return jsonRes(handleSubmitAll(data));
    if (data.action === 'submitQuestionnaire')    return jsonRes(handleSubmitQuestionnaire(data));
    if (data.action === 'submitTreatmentRecord') return jsonRes(handleSubmitTreatmentRecord(data));
    return jsonRes({ success: false, error: 'Unknown action: ' + data.action });
  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return jsonRes({ success: false, error: err.message });
  }
}

function doGet(e) {
  try {
    const p   = e.parameter;
    const cfg = getConfig();

    if (p.action === 'getSlots') {
      return jsonRes(getMonthSlots(p.month, cfg));
    }
    if (p.action === 'verifyStaff') {
      return jsonRes({ ok: p.pw === cfg.STAFF_PASSWORD });
    }
    if (p.action === 'validateToken') {
      return jsonRes({ valid: false }); // 再予約トークン機能は将来実装
    }
    if (p.action === 'getPatientList') {
      return jsonRes(handleGetPatientList(cfg));
    }
    if (p.action === 'getPatientDetails') {
      return jsonRes(handleGetPatientDetails(p.customerId, cfg));
    }

    // レガシー JSONP（カレンダーのグレーアウト用）
    if (p.date && p.callback) {
      const booked = getBookedTimesForDate(p.date, cfg);
      const out = ContentService.createTextOutput(
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

/* ── 患者照合 ── */

function handleLookupPatient(data) {
  const cfg = getConfig();
  const name  = (data.name  || '').replace(/[\s　]/g, '');
  const phone = (data.phone || '').replace(/[\s\-\(\)\.]/g, '');
  if (!name || !phone) return { success: true, found: false };

  const customer = findCustomerByNamePhone(cfg, name, phone);
  if (!customer) return { success: true, found: false };

  return {
    success:    true,
    found:      true,
    customerId: customer.id,
    patientNum: getTextProp(customer.properties, '診察番号'),
    name:       getTextProp(customer.properties, '名前'),
    furigana:   getTextProp(customer.properties, 'フリガナ'),
  };
}

function findCustomerByNamePhone(cfg, normName, normPhone) {
  const res = notionQuery(cfg, cfg.CUSTOMER_DB_ID, { page_size: 100 });
  for (var i = 0; i < res.results.length; i++) {
    var page = res.results[i];
    var storedName  = getTextProp(page.properties, '名前').replace(/[\s　]/g, '');
    var storedPhone = ((page.properties['電話番号'] && page.properties['電話番号'].phone_number) || '')
                       .replace(/[\s\-\(\)\.]/g, '');
    if (storedName === normName && storedPhone === normPhone) return page;
  }
  return null;
}

function handleGetPatientList(cfg) {
  var res = notionQuery(cfg, cfg.CUSTOMER_DB_ID, {
    sorts: [{ property: '名前', direction: 'ascending' }],
    page_size: 100,
  });
  if (!res.results) {
    Logger.log('getPatientList error: ' + JSON.stringify(res));
    return { success: false, error: res.message || JSON.stringify(res) };
  }
  // 今日のカルテを取得し、未記録（売上金額未入力）の患者IDを抽出
  var pendingIds = {};
  var todayKartes = notionQuery(cfg, cfg.KARTE_DB_ID, {
    filter: { property: '日付', date: { equals: todayStr() } },
    page_size: 100,
  });
  if (todayKartes.results) {
    todayKartes.results.forEach(function(k) {
      var rel = k.properties['顧客マスタ'] && k.properties['顧客マスタ'].relation;
      if (!rel || !rel.length) return;
      var cid = rel[0].id;
      var hasSales = k.properties['売上金額'] &&
                     k.properties['売上金額'].number !== null &&
                     k.properties['売上金額'].number !== undefined;
      // すでに recorded なら false を維持、まだなら true
      if (!pendingIds.hasOwnProperty(cid)) {
        pendingIds[cid] = !hasSales;
      } else if (hasSales) {
        pendingIds[cid] = false;
      }
    });
  }

  var patients = [];
  for (var i = 0; i < res.results.length; i++) {
    var page = res.results[i];
    var name = getTextProp(page.properties, '名前');
    if (!name) continue;
    var creditBalance = (page.properties['クレジット残高'] && page.properties['クレジット残高'].number) || 0;
    patients.push({
      customerId:      page.id,
      patientNum:      getTextProp(page.properties, '診察番号'),
      name:            name,
      furigana:        getTextProp(page.properties, 'フリガナ'),
      creditBalance:   creditBalance,
      treatmentPending: pendingIds[page.id] || false,
    });
  }
  return { success: true, patients: patients };
}

function handleGetPatientDetails(customerId, cfg) {
  if (!customerId) return { success: false, error: 'customerId required' };

  // 顧客ページからクレジット情報取得
  var cusRes = UrlFetchApp.fetch(NOTION_API + '/pages/' + customerId, {
    headers: notionHeaders(cfg),
    muteHttpExceptions: true,
  });
  var customer = JSON.parse(cusRes.getContentText());
  var creditBalance  = (customer.properties['クレジット残高'] && customer.properties['クレジット残高'].number) || 0;
  var creditDetailStr = getTextProp(customer.properties, 'クレジット詳細');
  var credits = parseCredits(creditDetailStr);

  // 60日以内に期限切れになるクレジットを抽出
  var today = new Date();
  var expiringCredits = [];
  credits.forEach(function(c) {
    var exp = new Date(c.date);
    exp.setFullYear(exp.getFullYear() + 1);
    var daysLeft = Math.floor((exp - today) / 86400000);
    if (daysLeft >= 0 && daysLeft <= 60) {
      expiringCredits.push({ amount: c.amount, daysLeft: daysLeft, expiryDate: fmtDate(exp) });
    }
  });

  // 通算施術回数・前回来院日をカルテDBから取得
  var karteRes = notionQuery(cfg, cfg.KARTE_DB_ID, {
    filter: { property: '顧客マスタ', relation: { contains: customerId } },
    sorts:  [{ property: '日付', direction: 'descending' }],
    page_size: 100,
  });
  var visitCount    = karteRes.results ? karteRes.results.length : 0;
  var lastVisitDate = '';
  if (visitCount > 0) {
    var dp = karteRes.results[0].properties['日付'];
    if (dp && dp.date) lastVisitDate = dp.date.start;
  }

  // 初回判定: カルテが0件、または1件で且つそれが今日のもの（問診票送信で当日作成されたケース）
  var isFirstVisit = visitCount === 0 || (visitCount === 1 && lastVisitDate === todayStr());

  // 今日のカルテが件数に含まれているか
  var todayIncluded = visitCount > 0 && lastVisitDate === todayStr();
  // 今日が何回目か（今日のカルテが含まれていればそのまま、なければ+1）
  var visitNum = isFirstVisit ? 1 : (todayIncluded ? visitCount : visitCount + 1);

  // 前回来院日（今日のカルテを除いた直近）
  var prevVisitDate = '';
  if (!isFirstVisit && karteRes.results) {
    for (var i = 0; i < karteRes.results.length; i++) {
      var dp2 = karteRes.results[i].properties['日付'];
      var d2  = dp2 && dp2.date ? dp2.date.start : '';
      if (d2 && d2 !== todayStr()) { prevVisitDate = d2; break; }
    }
  }

  return {
    success:         true,
    creditBalance:   creditBalance,
    expiringCredits: expiringCredits,
    visitCount:      visitCount,
    visitNum:        visitNum,
    prevVisitDate:   prevVisitDate,
    isFirstVisit:    isFirstVisit,
  };
}

/* ── 予約送信 ── */

function handleSubmitBooking(data) {
  const cfg = getConfig();

  // 顧客マスタ検索 or 新規作成
  let customer   = data.email ? findCustomerByEmail(cfg, data.email) : null;
  let customerId, patientNum;

  if (customer) {
    customerId = customer.id;
    patientNum = getTextProp(customer.properties, '診察番号');
    if (!patientNum) {
      patientNum = generatePatientNumber(cfg);
      updateCustomerProp(cfg, customerId, { '診察番号': richText(patientNum) });
    }
  } else {
    patientNum = generatePatientNumber(cfg);
    const page = createCustomer(cfg, data, patientNum);
    customerId = page.id;
  }

  // カルテ作成（問診票なし：再来院・新症状なしのみ）
  createKarte(cfg, data, customerId, patientNum, false);

  // 確認メール
  if (data.email) sendBookingEmail(cfg, data, patientNum);

  return { success: true, bookingNumber: patientNum };
}

/* ── 問診票送信（スタンドアロン・メインエントリ） ── */

function handleSubmitAll(data) {
  const cfg = getConfig();
  let customerId = data.customerId || '';
  let patientNum = data.patientNum || '';

  if (data.visitType === 'return' && customerId) {
    // 再来院：照合済み customerId + patientNum を直接使用。基本情報は更新しない
    // patientNum は lookupPatient で返却済みのため frontend から受け取る
  } else {
    // 初回：名前＋電話で再確認してから新規作成
    var normName  = (data.name  || '').replace(/[\s　]/g, '');
    var normPhone = (data.phone || '').replace(/[\s\-\(\)\.]/g, '');
    var existing  = findCustomerByNamePhone(cfg, normName, normPhone);

    if (existing) {
      customerId = existing.id;
      patientNum = getTextProp(existing.properties, '診察番号');
      if (!patientNum) {
        patientNum = generatePatientNumber(cfg);
        updateCustomerProp(cfg, customerId, { '診察番号': richText(patientNum) });
      }
      var upd = {};
      if (data.dob) upd['生年月日'] = { date: { start: data.dob } };
      if (data.furigana) upd['フリガナ'] = richText(data.furigana);
      if (data.howFound) {
        var hfLabel = VALUE_LABEL[data.howFound] || data.howFound;
        upd['来院のきっかけ'] = { multi_select: [{ name: hfLabel }] };
      }
      if (data.lang) upd['言語'] = { select: { name: data.lang } };
      if (Object.keys(upd).length) updateCustomerProp(cfg, customerId, upd);
    } else {
      patientNum = generatePatientNumber(cfg);
      var page = createCustomer(cfg, data, patientNum);
      customerId = page.id;
    }
  }

  // コース名解決（courseId 優先。初回患者はコース未選択のため '未定'）
  data.resolvedCourseName = COURSE_ID_MAP[data.courseId]
    || COURSE_NAME_MAP[data.courseName]
    || data.courseName
    || '未定';

  // カルテ作成
  var hasQ = data.visitType === 'first' || data.hasChanges === 'yes';
  var karte = createKarte(cfg, data, customerId, patientNum, hasQ);

  // 人体図保存（Drive PDF）
  var bodyImageUrl = '';
  var bodyDebug = 'skipped';
  if (hasQ) {
    if (!data.bodyImage || data.bodyImage.length <= 100) {
      bodyDebug = 'no_data(len=' + (data.bodyImage ? data.bodyImage.length : 0) + ')';
    } else if (!cfg.DRIVE_FOLDER_ID) {
      bodyDebug = 'no_folder_id';
    } else {
      bodyImageUrl = saveBodyImage(cfg, data.bodyImage, patientNum);
      bodyDebug = bodyImageUrl ? 'saved' : 'save_failed';
    }
  }

  // 署名画像保存（Drive PDF）
  var signatureUrl = '';
  var sigDebug = 'skipped';
  if (hasQ) {
    if (!data.signatureImage || data.signatureImage.length <= 100) {
      sigDebug = 'no_data(len=' + (data.signatureImage ? data.signatureImage.length : 0) + ')';
    } else if (!cfg.DRIVE_FOLDER_ID) {
      sigDebug = 'no_folder_id';
    } else {
      signatureUrl = saveBodyImage(cfg, data.signatureImage, 'sig_' + patientNum);
      sigDebug = signatureUrl ? 'saved' : 'save_failed';
    }
  }

  // 問診票ブロック追記
  if (hasQ) appendQuestionnaireBlocks(cfg, karte.id, data, bodyImageUrl, signatureUrl);

  return { success: true, patientNum: patientNum, _bodyDebug: bodyDebug, _sigDebug: sigDebug };
}

/* ── 問診票送信 ── */

function handleSubmitQuestionnaire(data) {
  const cfg = getConfig();

  // 顧客を特定（メール → 診察番号の順で検索）
  let customer = null;
  if (data.email) customer = findCustomerByEmail(cfg, data.email);
  if (!customer && data.booking && data.booking.startsWith('LBC-')) {
    customer = findCustomerByPatientNum(cfg, data.booking);
  }

  // 生年月日・住所を顧客マスタに反映
  if (customer && data.dob) {
    updateCustomerProp(cfg, customer.id, { '生年月日': { date: { start: data.dob } } });
  }

  // 最新カルテを検索
  let karteId = null;
  if (customer) {
    const karte = findMostRecentKarte(cfg, customer.id);
    karteId = karte ? karte.id : null;
  }

  // 人体図を Drive PDF に保存
  let bodyImageUrl = '';
  if (data.bodyImage && data.bodyImage.length > 100 && cfg.DRIVE_FOLDER_ID) {
    bodyImageUrl = saveBodyImage(cfg, data.bodyImage, data.booking || 'q');
  }

  // 署名画像を Drive PDF に保存
  let signatureUrl = '';
  if (data.signatureImage && data.signatureImage.length > 100 && cfg.DRIVE_FOLDER_ID) {
    signatureUrl = saveBodyImage(cfg, data.signatureImage, 'sig_' + (data.booking || 'q'));
  }

  // カルテページに問診票内容を追記
  if (karteId) {
    appendQuestionnaireBlocks(cfg, karteId, data, bodyImageUrl, signatureUrl);
  }

  return { success: true };
}

/* ============================================================
   Notion — 顧客マスタ操作
   ============================================================ */

function findCustomerByEmail(cfg, email) {
  const res = notionQuery(cfg, cfg.CUSTOMER_DB_ID, {
    filter: { property: 'メールアドレス', email: { equals: email } },
    page_size: 1,
  });
  return res.results[0] || null;
}

function findCustomerByPatientNum(cfg, num) {
  const res = notionQuery(cfg, cfg.CUSTOMER_DB_ID, {
    filter: { property: '診察番号', rich_text: { equals: num } },
    page_size: 1,
  });
  return res.results[0] || null;
}

function createCustomer(cfg, data, patientNum) {
  const today = todayStr();
  const langMap = { ja: 'ja', es: 'es', pt: 'pt' };
  const props = {
    '名前':        { title: [{ text: { content: data.name || '不明' } }] },
    'フリガナ':     richText(data.furigana || ''),
    '電話番号':     { phone_number: data.phone || null },
    'メールアドレス': { email: data.email || null },
    '初回訪問日':   { date: { start: today } },
    '診察番号':     richText(patientNum),
    '言語':        { select: langMap[data.lang] ? { name: langMap[data.lang] } : null },
  };
  if (data.dob) props['生年月日'] = { date: { start: data.dob } };
  if (data.howFound) {
    var hfLabel = VALUE_LABEL[data.howFound] || data.howFound;
    props['来院のきっかけ'] = { multi_select: [{ name: hfLabel }] };
  }
  return notionPost(cfg, '/pages', { parent: { database_id: cfg.CUSTOMER_DB_ID }, properties: props });
}

function updateCustomerProp(cfg, pageId, props) {
  notionPatch(cfg, '/pages/' + pageId, { properties: props });
}

function generatePatientNumber(cfg) {
  const res = notionQuery(cfg, cfg.CUSTOMER_DB_ID, {
    filter: { property: '診察番号', rich_text: { is_not_empty: true } },
    sorts: [{ property: '診察番号', direction: 'descending' }],
    page_size: 1,
  });
  let max = 0;
  if (res.results.length > 0) {
    const existing = getTextProp(res.results[0].properties, '診察番号');
    const n = parseInt((existing || '').replace(/\D/g, '')) || 0;
    max = n;
  }
  return 'P' + String(max + 1).padStart(3, '0');
}

/* ============================================================
   Notion — カルテ操作
   ============================================================ */

// Notion コース select の有効値（これ以外は送らない）
var VALID_COURSES = ['カイロプラクティック', '筋膜リリース', '吸い玉・カッピング', 'トータルケア', '月2回コース'];

// コースID（フォームの value）→ Notion セレクト名
var COURSE_ID_MAP = {
  'chiro':   'カイロプラクティック',
  'fascia':  '筋膜リリース',
  'cupping': '吸い玉・カッピング',
  'total':    'トータルケア',
  'monthly2': '月2回コース',
};

// コース表示名 → Notion セレクト名（後方互換）
var COURSE_NAME_MAP = {
  'カイロプラクティック': 'カイロプラクティック',
  '筋膜リリース':         '筋膜リリース',
  '吸玉（カッピング）':   '吸い玉・カッピング',
  'トータルケア':         'トータルケア',
  // スペイン語
  'Quiropráctica':        'カイロプラクティック',
  'Liberación Miofascial':'筋膜リリース',
  'Ventosa':              '吸い玉・カッピング',
  'Cuidado Total':        'トータルケア',
  // ポルトガル語
  'Quiropraxia':          'カイロプラクティック',
  'Liberação Miofascial': '筋膜リリース',
  'Cuidado Total':        'トータルケア',
};

function createKarte(cfg, data, customerId, patientNum, hasQuestionnaire) {
  const langMap = { ja: '日本語', es: 'Español', pt: 'Português' };
  const courseName = data.resolvedCourseName
    || COURSE_ID_MAP[data.courseId]
    || COURSE_NAME_MAP[data.courseName]
    || data.courseName
    || '未定';
  var dateLabel = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  var karteTitle = (data.name || patientNum) + ' (' + dateLabel + ')';
  const props = {
    '名前':     { title: [{ text: { content: karteTitle } }] },
    '日付':     { date: { start: todayStr() } },
    '予約日':   { date: { start: data.date || todayStr() } },
    '予約時間': richText(data.time || ''),
    'ステータス': { status: { name: '未着手' } },
    '対応言語': { select: { name: langMap[data.lang] || '日本語' } },
    '顧客マスタ': { relation: [{ id: customerId }] },
    '問診票':   { checkbox: !!hasQuestionnaire },
  };
  if (courseName && VALID_COURSES.indexOf(courseName) !== -1) {
    props['コース'] = { select: { name: courseName } };
  }
  return notionPost(cfg, '/pages', { parent: { database_id: cfg.KARTE_DB_ID }, properties: props });
}

function findMostRecentKarte(cfg, customerId) {
  const res = notionQuery(cfg, cfg.KARTE_DB_ID, {
    filter: { property: '顧客マスタ', relation: { contains: customerId } },
    sorts: [{ property: '日付', direction: 'descending' }],
    page_size: 1,
  });
  return res.results[0] || null;
}

function findTodayKarte(cfg, customerId) {
  var res = notionQuery(cfg, cfg.KARTE_DB_ID, {
    filter: {
      and: [
        { property: '顧客マスタ', relation: { contains: customerId } },
        { property: '日付', date: { equals: todayStr() } },
      ],
    },
    sorts: [{ property: '日付', direction: 'descending' }],
    page_size: 1,
  });
  return res.results[0] || null;
}

/* ── 施術記録シート ── */

function handleSubmitTreatmentRecord(data) {
  var cfg = getConfig();

  var karte = findTodayKarte(cfg, data.customerId);
  if (!karte) {
    data.resolvedCourseName = COURSE_ID_MAP[data.courseId] || '';
    karte = createKarte(cfg, data, data.customerId, data.patientNum, false);
  }

  var courseLabel = COURSE_ID_MAP[data.courseId] || '';
  var upd = { 'ステータス': { status: { name: '完了' } } };
  if (courseLabel)  upd['コース']      = { select: { name: courseLabel } };
  if (data.salesAmount !== undefined && data.salesAmount !== null && data.salesAmount !== '') {
    upd['売上金額'] = { number: Number(data.salesAmount) };
  }
  if (data.paymentMethod) upd['支払い方法'] = { select: { name: data.paymentMethod } };
  if (data.treatmentMemo) upd['施術メモ']   = richText(data.treatmentMemo);

  // 紹介・クレジット情報をカルテに記録
  if (data.referrerName)    upd['紹介者名']     = richText(data.referrerName);
  if (data.referralDiscount) upd['紹介割引適用'] = { checkbox: true };
  if (data.creditUsed && Number(data.creditUsed) > 0) {
    upd['クレジット使用額'] = { number: Number(data.creditUsed) };
  }

  notionPatch(cfg, '/pages/' + karte.id, { properties: upd });

  // 紹介者にクレジット付与（初回割引が適用された場合）
  if (data.referralDiscount && data.referrerId) {
    addCredit(cfg, data.referrerId, 1000);
  }

  // 患者のクレジット消費（FIFO）
  if (data.creditUsed && Number(data.creditUsed) > 0) {
    useCredit(cfg, data.customerId, Number(data.creditUsed));
  }

  return { success: true, patientNum: data.patientNum };
}

/* ── クレジット管理ヘルパー ── */

function parseCredits(str) {
  if (!str) return [];
  try { return JSON.parse(str); } catch(e) { return []; }
}

function serializeCredits(arr) {
  return JSON.stringify(arr);
}

function addCredit(cfg, customerId, amount) {
  var res = UrlFetchApp.fetch(NOTION_API + '/pages/' + customerId, {
    headers: notionHeaders(cfg), muteHttpExceptions: true,
  });
  var page = JSON.parse(res.getContentText());
  var balance = (page.properties['クレジット残高'] && page.properties['クレジット残高'].number) || 0;
  var credits = parseCredits(getTextProp(page.properties, 'クレジット詳細'));
  credits.push({ date: todayStr(), amount: amount });
  updateCustomerProp(cfg, customerId, {
    'クレジット残高': { number: balance + amount },
    'クレジット詳細': richText(serializeCredits(credits)),
  });
}

function useCredit(cfg, customerId, amount) {
  var res = UrlFetchApp.fetch(NOTION_API + '/pages/' + customerId, {
    headers: notionHeaders(cfg), muteHttpExceptions: true,
  });
  var page = JSON.parse(res.getContentText());
  var balance = (page.properties['クレジット残高'] && page.properties['クレジット残高'].number) || 0;
  var credits = parseCredits(getTextProp(page.properties, 'クレジット詳細'));

  // 古い順（FIFO）で消費
  credits.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
  var remaining = amount;
  var newCredits = [];
  for (var i = 0; i < credits.length; i++) {
    if (remaining <= 0) { newCredits.push(credits[i]); continue; }
    if (credits[i].amount <= remaining) {
      remaining -= credits[i].amount;
    } else {
      newCredits.push({ date: credits[i].date, amount: credits[i].amount - remaining });
      remaining = 0;
    }
  }
  updateCustomerProp(cfg, customerId, {
    'クレジット残高': { number: Math.max(0, balance - amount) },
    'クレジット詳細': richText(serializeCredits(newCredits)),
  });
}

// フォームの内部値 → 日本語表示名
var VALUE_LABEL = {
  // 来院のきっかけ
  instagram: 'Instagram', google: 'Google', google_maps: 'Google Maps',
  referral: '紹介', other: 'その他',
  // 主症状（HTML value と完全一致）
  shoulder_stiff: '肩こり', lower_back: '腰痛', neck_stiff: '首こり', headache: '頭痛',
  posture: '姿勢', fatigue: '疲労', swelling: 'むくみ',
  // 症状の期間（HTML value と完全一致）
  within_week: '1週間以内', within_month: '1ヶ月以内', over_month: '1ヶ月以上', over_half_year: '半年以上',
  // 安全確認（HTML value と完全一致）
  pregnant: '妊娠中／妊娠の可能性', hospital: '通院中', osteoporosis: '骨粗しょう症',
  blood_thinner: '血液をサラサラにする薬', numbness: '強いしびれ', recent_injury: '最近の怪我・手術',
  none: '特になし',
  // 施術目的（HTML value と完全一致）
  relax: 'リラックスしたい', pain_relief: '痛みを改善したい',
  posture_goal: '姿勢を整えたい', root_cause: '根本改善を目指したい', maintenance: '身体のメンテナンス',
  // 施術強さ
  light: '弱め', normal: '普通', strong: '強め',
  // 苦手な施術
  strong_pressure: '強い圧', joint_adjustment: '関節調整（ボキボキ）',
};

function toJa(arr) {
  if (!arr || !arr.length) return null;
  return arr.map(function(v) { return VALUE_LABEL[v] || v; });
}

function appendQuestionnaireBlocks(cfg, karteId, data, bodyImageUrl, signatureUrl) {
  var sep = '、';

  // DOBから年齢を計算
  var ageStr = '';
  if (data.dob) {
    var dobParts = data.dob.split('-');
    if (dobParts.length === 3) {
      var today = new Date();
      var age = today.getFullYear() - parseInt(dobParts[0]);
      var bMonth = parseInt(dobParts[1]), bDay = parseInt(dobParts[2]);
      if (today.getMonth() + 1 < bMonth || (today.getMonth() + 1 === bMonth && today.getDate() < bDay)) age--;
      if (age >= 0 && age <= 130) ageStr = '（' + age + '歳）';
    }
  }

  // 来院のきっかけ（初回のみ）
  var howFoundLabel = '';
  if (data.howFound) {
    howFoundLabel = VALUE_LABEL[data.howFound] || data.howFound;
    if (data.howFound === 'referral' && data.referrerName) howFoundLabel += ' (' + data.referrerName + ')';
    if (data.howFound === 'other' && data.howFoundOther) howFoundLabel += ' (' + data.howFoundOther + ')';
  }

  // 安全確認
  var safetyLabel = '';
  if (data.safetyCheck && data.safetyCheck.length) {
    safetyLabel = data.safetyCheck.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep);
    if (data.safetyNote) safetyLabel += '　' + data.safetyNote;
  } else if (data.safetyNote) {
    safetyLabel = data.safetyNote;
  }

  // 苦手な施術
  var dislikedLabel = '';
  if (data.dislikedTreatment && data.dislikedTreatment.length) {
    dislikedLabel = data.dislikedTreatment.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep);
  }

  // 主症状
  var mainSymLabel = '—';
  if (data.mainSymptom) {
    mainSymLabel = VALUE_LABEL[data.mainSymptom] || data.mainSymptom;
    if (data.mainSymptom === 'other' && data.mainSymptomOther) mainSymLabel = data.mainSymptomOther;
  }

  // 痛みレベルのバー表示
  var painStr = '—';
  if (data.painLevel !== null && data.painLevel !== undefined) {
    var lvl = parseInt(data.painLevel);
    var bar = (lvl >= 1 && lvl <= 10) ? '■'.repeat(lvl) + '□'.repeat(10 - lvl) : '';
    painStr = lvl + ' / 10  ' + bar;
  }

  // ── ブロックヘルパー ──
  function rt(text, bold, color) {
    var obj = { type: 'text', text: { content: text } };
    var ann = {};
    if (bold)  ann.bold  = true;
    if (color) ann.color = color;
    if (Object.keys(ann).length) obj.annotations = ann;
    return obj;
  }
  function h2(emoji, title) {
    return { object: 'block', type: 'heading_2', heading_2: {
      rich_text: [rt(emoji + '  ' + title)]
    }};
  }
  function div() { return { object: 'block', type: 'divider', divider: {} }; }
  function bul(label, value) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: {
      rich_text: [rt(label + ': ', true), rt(value)]
    }};
  }
  function co(text, icon, color) {
    return { object: 'block', type: 'callout', callout: {
      rich_text: [rt(text)],
      icon: { type: 'emoji', emoji: icon },
      color: color
    }};
  }
    function imgBlock(url) {
    return { object: 'block', type: 'embed', embed: { url: url } };
  }

  var blocks = [];
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  var visitLabel = data.visitType === 'first' ? '初回来院' : '再診';

  // ── ヘッダー
  blocks.push(co('問診票　' + dateStr + '　' + visitLabel, '📋', 'blue_background'));

  // ── 1. 基本情報
  blocks.push(h2('👤', '基本情報'));
  if (data.name)     blocks.push(bul('氏名', data.name));
  if (data.furigana) blocks.push(bul('フリガナ', data.furigana));
  blocks.push(bul('来院歴', data.visitType === 'first' ? '初回' : '再診'));
  if (data.visitType !== 'first' && data.hasChanges) {
    blocks.push(bul('症状の変化', data.hasChanges === 'yes' ? 'あり（新しい問診あり）' : 'なし'));
  }
  if (data.visitType === 'first' && howFoundLabel) blocks.push(bul('来院のきっかけ', howFoundLabel));
  if (data.dob) blocks.push(bul('生年月日', data.dob + ageStr));
  if (data.phone) blocks.push(bul('電話番号', data.phone));
  if (data.email) blocks.push(bul('メールアドレス', data.email));
  blocks.push(div());

  // ── 2. 本日のお悩み
  blocks.push(h2('🤕', '本日のお悩み'));
  blocks.push(bul('主症状', mainSymLabel));
  if (data.symptomDuration) blocks.push(bul('症状の期間', VALUE_LABEL[data.symptomDuration] || data.symptomDuration));
  blocks.push(bul('痛みレベル', painStr));
  blocks.push(div());

  // ── 3. 安全確認
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

  // ── 4. 本日のご希望
  blocks.push(h2('💆', '本日のご希望'));
  if (data.treatmentGoal)     blocks.push(bul('施術目的', VALUE_LABEL[data.treatmentGoal] || data.treatmentGoal));
  if (data.treatmentStrength) blocks.push(bul('強さ希望', VALUE_LABEL[data.treatmentStrength] || data.treatmentStrength));
  if (dislikedLabel)          blocks.push(bul('苦手な施術', dislikedLabel));
  blocks.push(div());

  // ── 5. 撮影同意
  if (data.photoConsent) {
    blocks.push(div());
    blocks.push(h2('📸', '撮影同意'));
    var photoLabel = data.photoConsent === 'yes' ? 'はい（協力可）' : 'いいえ（辞退）';
    blocks.push(bul('撮影協力', photoLabel));
    if (data.photoConsent === 'yes' && data.facePreference) {
      var faceLabel = data.facePreference === 'face_ok' ? '顔出しOK' : '顔は映さないでほしい';
      blocks.push(bul('顔出し', faceLabel));
    }
    blocks.push(div());
  }

  // ── 6. 同意
  blocks.push(h2('✅', '同意'));
  var consentText = data.consentAgreed ? '✓  同意済み' : '✗  未同意';
  if (data.consentDate) consentText += '（' + data.consentDate + '）';
  blocks.push({ object: 'block', type: 'paragraph', paragraph: {
    rich_text: [rt(consentText, false, data.consentAgreed ? 'green' : 'red')]
  }});

  // ── 人体図・署名（常に表示）
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
   スロット管理
   ============================================================ */

function getMonthSlots(monthStr, cfg) {
  if (!monthStr) return { success: false, error: 'month required' };
  const [y, m] = monthStr.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  const allTimes = [];
  for (let h = 8; h < 22; h++) {
    for (const min of [0, 30]) {
      allTimes.push(String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0'));
    }
  }

  // 月全体を1回のAPIコールで取得
  const startDate = fmtDate(new Date(y, m - 1, 1));
  const endDate   = fmtDate(new Date(y, m - 1, days));
  const bookedByDate = getAllBookingsForMonth(cfg, startDate, endDate);

  const result = {};
  for (let d = 1; d <= days; d++) {
    const dt = new Date(y, m - 1, d);
    if (dt < today) continue;
    const ds = fmtDate(dt);
    const booked = bookedByDate[ds] || [];
    result[ds] = allTimes.filter(t => !booked.includes(t));
  }
  return { success: true, slots: result };
}

function getAllBookingsForMonth(cfg, startDate, endDate) {
  try {
    const res = notionQuery(cfg, cfg.KARTE_DB_ID, {
      filter: {
        and: [
          { property: '予約日', date: { on_or_after:  startDate } },
          { property: '予約日', date: { on_or_before: endDate   } },
        ],
      },
      page_size: 100,
    });
    const byDate = {};
    res.results.forEach(function(p) {
      const date = p.properties['予約日'] && p.properties['予約日'].date && p.properties['予約日'].date.start;
      const time = getTextProp(p.properties, '予約時間');
      if (date && time) {
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push(time);
      }
    });
    return byDate;
  } catch (err) {
    Logger.log('getAllBookingsForMonth error: ' + err.message);
    return {};
  }
}

function getBookedTimesForDate(dateStr, cfg) {
  try {
    const res = notionQuery(cfg, cfg.KARTE_DB_ID, {
      filter: { property: '予約日', date: { equals: dateStr } },
      page_size: 100,
    });
    return res.results
      .map(p => getTextProp(p.properties, '予約時間'))
      .filter(Boolean);
  } catch (err) {
    Logger.log('getBookedTimesForDate error: ' + err.message);
    return [];
  }
}

/* ============================================================
   メール送信
   ============================================================ */

function sendBookingEmail(cfg, data, patientNum, includeQLink) {
  if (includeQLink === undefined) includeQLink = true;
  try {
    let qLine = '';
    if (includeQLink) {
      const siteUrl = cfg.SITE_URL || '';
      const needsQ  = data.visitType === 'first' || data.hasNewSymptom === 'yes';
      if (needsQ && siteUrl) {
        const qUrl = siteUrl + '/questionnaire.html?lang=' + (data.lang || 'ja') +
          '&name='    + encodeURIComponent(data.name  || '') +
          '&phone='   + encodeURIComponent(data.phone || '') +
          '&email='   + encodeURIComponent(data.email || '') +
          '&booking=' + encodeURIComponent(patientNum) +
          '&visit='   + (data.visitType || 'first');
        qLine = '\n\n■ 問診票\n' + qUrl;
      }
    }

    const tmpl = {
      ja: { subj: '[LBC整体院] 仮予約を受け付けました',  greeting: '様', body1: '仮予約を受け付けました。内容を確認後、担当者よりご連絡いたします。', num: '■ 予約番号', dt: '■ 日時', course: '■ コース' },
      es: { subj: '[LBC Care] Reserva provisional recibida', greeting: ',', body1: 'Hemos recibido su reserva provisional. Le confirmaremos a la brevedad.', num: '■ N° de reserva', dt: '■ Fecha y hora', course: '■ Servicio' },
      pt: { subj: '[LBC Care] Agendamento provisório recebido', greeting: ',', body1: 'Recebemos seu agendamento provisório. Entraremos em contato em breve para confirmar.', num: '■ N° do agendamento', dt: '■ Data e horário', course: '■ Serviço' },
    };
    const t = tmpl[data.lang] || tmpl.ja;
    const subject = t.subj + '（' + patientNum + '）';
    const lines = [
      data.name + ' ' + t.greeting,
      '',
      t.body1,
      '',
      t.num  + ': ' + patientNum,
      t.dt   + ': ' + data.date + ' ' + data.time,
      t.course + ': ' + (data.courseName || ''),
    ];
    if (qLine) lines.push(qLine);
    lines.push('', '──────────────', 'LBC Care / Lucas Body Care', '〒510-0835 Mie Yokkaichi Ooide', 'TEL: 070-9233-4084');
    const body = lines.join('\n');

    MailApp.sendEmail({ to: data.email, subject, body });
  } catch (err) {
    Logger.log('sendBookingEmail error: ' + err.message);
  }
}

/* ============================================================
   Google Drive — 人体図・署名をPDFで保存
   ============================================================ */

function saveBodyImage(cfg, base64DataUrl, prefix) {
  try {
    const match = base64DataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/s);
    if (!match) {
      Logger.log('saveBodyImage: regex no match. len=' + (base64DataUrl || '').length + ' head=' + (base64DataUrl || '').substring(0, 40));
      return '';
    }
    const mimeType = 'image/' + match[1];
    const bytes = Utilities.base64Decode(match[2]);
    const fileName = 'body_' + prefix + '_' + new Date().getTime();

    // 一時Google Docに画像を挿入してPDFへ変換
    const tmpDoc = DocumentApp.create('_tmp_' + fileName);
    const body = tmpDoc.getBody();
    body.insertImage(0, Utilities.newBlob(bytes, mimeType, fileName));
    tmpDoc.saveAndClose();

    const tmpFile = DriveApp.getFileById(tmpDoc.getId());
    const pdfBlob = tmpFile.getAs('application/pdf');
    pdfBlob.setName(fileName + '.pdf');

    // 指定フォルダにPDFを保存
    const folder = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
    const pdfFile = folder.createFile(pdfBlob);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // 一時Docを削除
    tmpFile.setTrashed(true);

    Logger.log('saveBodyImage: PDF saved, id=' + pdfFile.getId());
    return 'https://drive.google.com/file/d/' + pdfFile.getId() + '/preview';
  } catch (err) {
    Logger.log('saveBodyImage error: ' + err.message + '\nstack: ' + err.stack);
    return '';
  }
}

/* ============================================================
   Notion API ヘルパー
   ============================================================ */

function notionHeaders(cfg) {
  return {
    'Authorization': 'Bearer ' + cfg.NOTION_TOKEN,
    'Notion-Version': NOTION_VER,
    'Content-Type': 'application/json',
  };
}

function notionQuery(cfg, dbId, body) {
  const res = UrlFetchApp.fetch(NOTION_API + '/databases/' + dbId + '/query', {
    method: 'post',
    headers: notionHeaders(cfg),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPost(cfg, path, body) {
  const res = UrlFetchApp.fetch(NOTION_API + path, {
    method: 'post',
    headers: notionHeaders(cfg),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

function notionPatch(cfg, path, body) {
  const res = UrlFetchApp.fetch(NOTION_API + path, {
    method: 'patch',
    headers: notionHeaders(cfg),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}

/* ============================================================
   ユーティリティ
   ============================================================ */

function getConfig() {
  return PropertiesService.getScriptProperties().getProperties();
}

function jsonRes(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function richText(content) {
  return { rich_text: [{ type: 'text', text: { content: content || '' } }] };
}

function getTextProp(props, key) {
  const p = props[key];
  if (!p) return '';
  if (p.rich_text) return (p.rich_text[0] && p.rich_text[0].plain_text) || '';
  if (p.title)     return (p.title[0]     && p.title[0].plain_text)     || '';
  return '';
}

function todayStr() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function fmtDate(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/* ============================================================
   テスト — 全データ書き込み確認（GASエディタから手動実行）
   ============================================================ */

function testSubmitAll() {
  // テスト用PNG（10x10 赤色）
  var tiny1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAFUlEQVR4nGP8z8BQTwMJDIViIAYABzYABWtIJfEAAAAASUVORK5CYII=';

  var testData = {
    action:            'submitAll',
    visitType:         'first',
    name:              'テスト太郎',
    furigana:          'テストタロウ',
    phone:             '090-1234-5678',
    email:             '',
    dob:               '1990-04-01',
    lang:              'ja',
    howFound:          'google',
    courseId:          'total',
    hasChanges:        'yes',
    // 症状
    mainSymptom:       'lower_back',
    symptomDuration:   'over_month',
    painLevel:         7,
    // 安全確認
    safetyCheck:       ['hospital'],
    safetyNote:        '高血圧',
    safetyDetail:      { hospital: '四日市市民病院' },
    // 希望
    treatmentGoal:     'pain_relief',
    treatmentStrength: 'normal',
    dislikedTreatment: ['joint_adjustment'],
    // 撮影同意
    photoConsent:      'yes',
    facePreference:    'face_ok',
    // 同意
    consentAgreed:     true,
    consentDate:       '2026-07-26',
    // 画像（テスト用ダミー）
    bodyImage:         tiny1x1,
    signatureImage:    tiny1x1,
  };

  var result = handleSubmitAll(testData);
  Logger.log('=== テスト結果 ===');
  Logger.log(JSON.stringify(result, null, 2));
  if (result._bodyDebug)  Logger.log('人体図: ' + result._bodyDebug);
  if (result._sigDebug)   Logger.log('署名:   ' + result._sigDebug);
  if (result.success) {
    Logger.log('✅ 成功！ Notionのカルテ「テスト太郎」を確認してください');
  } else {
    Logger.log('❌ エラー: ' + result.error);
  }
}

/* ============================================================
   セットアップ — Notionフィールド追加（一度だけ実行）
   ============================================================ */

function addNotionFields() {
  var cfg = getConfig();
  var h   = notionHeaders(cfg);

  var customerRes = UrlFetchApp.fetch(NOTION_API + '/databases/' + cfg.CUSTOMER_DB_ID, {
    method: 'patch', headers: h, muteHttpExceptions: true,
    payload: JSON.stringify({
      properties: {
        'クレジット残高': { number: { format: 'yen' } },
        'クレジット詳細': { rich_text: {} },
      }
    }),
  });
  Logger.log('カスタマーDB: ' + customerRes.getResponseCode() + ' ' + customerRes.getContentText().substring(0, 200));

  var karteRes = UrlFetchApp.fetch(NOTION_API + '/databases/' + cfg.KARTE_DB_ID, {
    method: 'patch', headers: h, muteHttpExceptions: true,
    payload: JSON.stringify({
      properties: {
        '紹介者名':       { rich_text: {} },
        'クレジット使用額': { number: { format: 'yen' } },
        '紹介割引適用':   { checkbox: {} },
      }
    }),
  });
  Logger.log('カルテDB: ' + karteRes.getResponseCode() + ' ' + karteRes.getContentText().substring(0, 200));

  Logger.log('完了！ログを確認してください。');
}
