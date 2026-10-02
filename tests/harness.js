// GAS の Code.js を Node の vm に読み込み、Google サービスをモックして関数単体をテストするためのハーネス
//  使い方: const g = loadGas({ props: { STAFF_ACCESS_TOKEN: '...' } });  g.doPost(...)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_PATH = path.join(__dirname, '..', 'gas', 'Code.js');

// シートのモック: { タブ名: [[ヘッダー...], [行...], ...] }。appendRow / setValue(s) は配列に反映される
function mockSpreadsheet(tabs) {
  function sheet(name) {
    const data = tabs[name];
    if (!data) return null;
    const range = (r, c, nr, nc) => ({
      getValues: () => data.slice(r - 1, r - 1 + (nr || 1)).map(row => {
        const out = []; for (let j = 0; j < (nc || 1); j++) out.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); return out;
      }),
      getValue: () => (data[r - 1] || [])[c - 1],
      setValue: (v) => { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = v; },
      setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => { data[r - 1 + i] = data[r - 1 + i] || []; data[r - 1 + i][c - 1 + j] = v; })),
    });
    return {
      getName: () => name,
      getLastRow: () => data.length,
      getLastColumn: () => data.reduce((m, row) => Math.max(m, row.length), 0),
      getRange: range,
      getDataRange: () => range(1, 1, data.length, data.reduce((m, row) => Math.max(m, row.length), 0)),
      appendRow: (row) => { data.push(row.slice()); },
    };
  }
  return { getSheetByName: sheet, getId: () => 'mock-ss', tabs };
}

// Utilities.formatDate の簡易版(Asia/Tokyo 固定。yyyy MM dd HH mm ss と '...' リテラルのみ対応)
function formatDateJst(date, tz, fmt) {
  const d = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const map = { yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()) };
  return fmt.split(/('[^']*')/).map(part => part.startsWith("'") ? part.slice(1, -1) : part.replace(/yyyy|MM|dd|HH|mm|ss/g, t => map[t])).join('');
}

function loadGas(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const logs = [];
  const sandbox = {
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => Object.assign({}, props),
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    // 呼ばれたら分かるように、未モックのサービスは例外にする
    SpreadsheetApp: new Proxy({}, { get: (_, k) => { throw new Error('SpreadsheetApp.' + String(k) + ' not mocked'); } }),
    UrlFetchApp: new Proxy({}, { get: (_, k) => { throw new Error('UrlFetchApp.' + String(k) + ' not mocked'); } }),
    Utilities: { sleep() {}, formatDate: formatDateJst, getUuid: () => 'uuid-' + Math.random().toString(36).slice(2) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true }) },
    CacheService: { getScriptCache: () => { const m = {}; return { get: k => m[k] || null, put: (k, v) => { m[k] = v; }, remove: k => { delete m[k]; } }; } },
  };
  if (opts.tabs) {
    const ss = mockSpreadsheet(opts.tabs);
    sandbox.SpreadsheetApp = { openById: () => ss, flush() {} };
    sandbox.__ss = ss;
  }
  Object.assign(sandbox, opts.globals || {});
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), sandbox, { filename: 'Code.js' });
  sandbox.__props = props;
  sandbox.__logs = logs;
  return sandbox;
}

// doPost を JSON ボディで呼び、レスポンスを JSON で返す
function post(g, body) {
  const out = g.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.text);
}

module.exports = { loadGas, post };
