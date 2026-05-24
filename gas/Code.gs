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
    if (data.action === 'submitQuestionnaire') return jsonRes(handleSubmitQuestionnaire(data));
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
    // 再来院：照合済み customerId を直接使用。基本情報は更新しない
    patientNum = patientNum || getTextProp(
      notionPost(cfg, '/pages/' + customerId, null, 'GET').properties, '診察番号'
    );
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
      var addr = [data.addressPref, data.addressCity].filter(Boolean).join(' ');
      if (addr) upd['住所'] = richText(addr);
      if (data.howFound && data.howFound.length)
        upd['来院のきっかけ'] = { multi_select: data.howFound.map(function(v) { return { name: VALUE_LABEL[v] || v }; }) };
      if (data.lang) upd['言語'] = { select: { name: data.lang } };
      if (Object.keys(upd).length) updateCustomerProp(cfg, customerId, upd);
    } else {
      patientNum = generatePatientNumber(cfg);
      var page = createCustomer(cfg, data, patientNum);
      customerId = page.id;
    }
  }

  // コース名解決（courseId 優先、courseName フォールバック）
  data.resolvedCourseName = COURSE_ID_MAP[data.courseId]
    || COURSE_NAME_MAP[data.courseName]
    || data.courseName
    || 'その他';

  // カルテ作成
  var hasQ = data.visitType === 'first' || data.hasChanges === 'yes';
  var karte = createKarte(cfg, data, customerId, patientNum, hasQ);

  // 人体図保存
  var bodyImageUrl = '';
  if (hasQ && data.bodyImage && data.bodyImage.length > 100 && cfg.DRIVE_FOLDER_ID) {
    bodyImageUrl = saveBodyImage(cfg, data.bodyImage, patientNum);
  }

  // 問診票ブロック追記
  if (hasQ) appendQuestionnaireBlocks(cfg, karte.id, data, bodyImageUrl);

  return { success: true, patientNum: patientNum };
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

  // 人体図を Drive に保存
  let bodyImageUrl = '';
  if (data.bodyImage && data.bodyImage.length > 100 && cfg.DRIVE_FOLDER_ID) {
    bodyImageUrl = saveBodyImage(cfg, data.bodyImage, data.booking || 'q');
  }

  // カルテページに問診票内容を追記
  if (karteId) {
    appendQuestionnaireBlocks(cfg, karteId, data, bodyImageUrl);
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
  const addr = [data.addressPref, data.addressCity].filter(Boolean).join(' ');
  if (addr) props['住所'] = richText(addr);
  if (data.howFound && data.howFound.length) {
    props['来院のきっかけ'] = { multi_select: data.howFound.map(function(v) { return { name: VALUE_LABEL[v] || v }; }) };
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
  return 'LBC-' + String(max + 1).padStart(4, '0');
}

/* ============================================================
   Notion — カルテ操作
   ============================================================ */

// コースID（フォームの value）→ Notion セレクト名
var COURSE_ID_MAP = {
  'chiro':   'カイロプラクティック',
  'fascia':  '筋膜リリース',
  'cupping': '吸い玉・カッピング',
  'total':   'トータルケア',
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
    || 'その他';
  const props = {
    '名前':     { title: [{ text: { content: (data.name || '不明') + '（' + patientNum + '）' } }] },
    '日付':     { date: { start: todayStr() } },
    '予約日':   { date: { start: data.date || todayStr() } },
    '予約時間': richText(data.time || ''),
    'コース':   { select: { name: courseName } },
    'ステータス': { status: { name: '未着手' } },
    '対応言語': { select: { name: langMap[data.lang] || '日本語' } },
    '顧客マスタ': { relation: [{ id: customerId }] },
    '問診票':   { checkbox: !!hasQuestionnaire },
  };
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

// フォームの内部値 → 日本語表示名
var VALUE_LABEL = {
  // Q1 症状
  fever: '発熱', pain: '激しい痛み', swelling: '炎症・腫れ', pregnant: '妊娠中',
  // Q2 病歴
  hernia: '椎間板ヘルニア', stenosis: '脊柱管狭窄症', shoulder: '五十肩',
  sciatica: '坐骨神経痛', fracture: '骨折・脱臼',
  // Q4 目標
  relax: 'リラックス', posture: '姿勢改善',
  // Q6 部位
  neck: '首', rShoulder: '右肩', lShoulder: '左肩', back: '背中',
  waist: '腰', elbow: '肘', wrist: '手首', hip: '股関節',
  knee: '膝', ankle: '足首',
  // 来院のきっかけ
  kuchikomi: '口コミ', instagram: 'Instagram', shokai: '紹介',
  kanban: '看板', other: 'その他',
};

function toJa(arr) {
  if (!arr || !arr.length) return null;
  return arr.map(function(v) { return VALUE_LABEL[v] || v; });
}

function appendQuestionnaireBlocks(cfg, karteId, data, bodyImageUrl) {
  // Notion は社内管理用のため常に日本語で記録する
  const labelMap = {
    ja: {
      title: '問診票',
      howFound: '来院のきっかけ',
      visitType: '来院歴',
      q1: 'Q1 症状', q2: 'Q2 病歴・過去の怪我', q3: 'Q3 現在の痛み',
      q4: 'Q4 施術の目標', q5: 'Q5 痛みの強度', q6: 'Q6 痛み部位',
      bodyDiagram: '人体図', address: '住所',
      first: '初回', return: '再診', none: 'なし', yes: 'あり', noPain: '痛みなし',
    },
    es: {
      title: '問診票',
      howFound: '来院のきっかけ',
      visitType: '来院歴',
      q1: 'Q1 症状', q2: 'Q2 病歴・過去の怪我', q3: 'Q3 現在の痛み',
      q4: 'Q4 施術の目標', q5: 'Q5 痛みの強度', q6: 'Q6 痛み部位',
      bodyDiagram: '人体図', address: '住所',
      first: '初回', return: '再診', none: 'なし', yes: 'あり', noPain: '痛みなし',
    },
    pt: {
      title: '問診票', howFound: '来院のきっかけ', visitType: '来院歴',
      q1: 'Q1 症状', q2: 'Q2 病歴・過去の怪我', q3: 'Q3 現在の痛み',
      q4: 'Q4 施術の目標', q5: 'Q5 痛みの強度', q6: 'Q6 痛み部位',
      bodyDiagram: '人体図', address: '住所',
      first: '初回', return: '再診', none: 'なし', yes: 'あり', noPain: '痛みなし',
    },
  };
  const lbl = labelMap[data.lang] || labelMap.ja;

  const sep = '、';
  function fmt(arr, other, noneVal) {
    if (!arr || arr.length === 0) return lbl.none;
    if (arr.includes('none') || arr[0] === noneVal) return lbl.none;
    const parts = arr.filter(function(v) { return v !== 'none'; })
                     .map(function(v) { return VALUE_LABEL[v] || v; });
    if (other) parts.push('（' + other + '）');
    return parts.join(sep);
  }

  const q3val = data.q3 === 'yes'
    ? lbl.yes + (data.q3Where ? ' — ' + data.q3Where : '')
    : lbl.none;

  const q5val = data.q5NoPain ? lbl.noPain
    : data.q5 ? data.q5 + ' / 5'
    : '—';

  // DOBから年齢を計算
  let ageStr = '';
  if (data.dob) {
    var parts = data.dob.split('-');
    if (parts.length === 3) {
      var today = new Date();
      var age = today.getFullYear() - parseInt(parts[0]);
      var bMonth = parseInt(parts[1]), bDay = parseInt(parts[2]);
      if (today.getMonth() + 1 < bMonth || (today.getMonth() + 1 === bMonth && today.getDate() < bDay)) age--;
      if (age >= 0 && age <= 130) ageStr = '（' + age + '歳）';
    }
  }

  const lines = [
    '━━━ ' + lbl.title + ' (' + new Date().toLocaleString('ja-JP') + ') ━━━',
    '',
    '【' + lbl.visitType + '】 ' + (data.visitType === 'first' ? lbl.first : lbl.return),
    '【' + lbl.howFound + '】 ' + (data.howFound && data.howFound.length
      ? data.howFound.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep)
      : '—'),
    data.dob ? '【生年月日】 ' + data.dob + ageStr : null,
    (data.addressPref || data.addressCity) ? '【' + lbl.address + '】 ' + [data.addressPref, data.addressCity].filter(Boolean).join(' ') : null,
    '',
    '【' + lbl.q1 + '】 ' + fmt(data.q1, data.q1Other, 'none'),
    '【' + lbl.q2 + '】 ' + fmt(data.q2, data.q2Other, 'none'),
    '【' + lbl.q3 + '】 ' + q3val,
    '【' + lbl.q4 + '】 ' + fmt(data.q4, data.q4Other),
    '【' + lbl.q5 + '】 ' + q5val,
    '【' + lbl.q6 + '】 ' + (data.q6 && data.q6.length
      ? data.q6.map(function(v) { return VALUE_LABEL[v] || v; }).join(sep)
      : '—'),
  ].filter(function(l) { return l !== null; });

  const blocks = lines.map(function(line) {
    return line === ''
      ? { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }
      : { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } };
  });

  // 人体図：Driveの直リンクでNotionに画像ブロックとして埋め込む
  if (bodyImageUrl) {
    var fileIdMatch = bodyImageUrl.match(/\/d\/([^\/\?]+)/);
    var embedUrl = fileIdMatch
      ? 'https://drive.google.com/uc?export=view&id=' + fileIdMatch[1]
      : bodyImageUrl;
    blocks.push({ object: 'block', type: 'image',
      image: { type: 'external', external: { url: embedUrl } } });
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
   Google Drive — 人体図保存
   ============================================================ */

function saveBodyImage(cfg, base64DataUrl, prefix) {
  try {
    const match = base64DataUrl.match(/^data:image\/(jpeg|png);base64,(.+)$/);
    if (!match) return '';
    const mimeType = 'image/' + match[1];
    const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), mimeType);
    const fileName = 'body_' + prefix + '_' + new Date().getTime() + '.' + match[1];
    blob.setName(fileName);
    const file = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  } catch (err) {
    Logger.log('saveBodyImage error: ' + err.message);
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
