/* i18n/i18n.js — 各言語 JSON を非同期ロードして window.I18N に格納する */
window.I18N = {};
window.I18N_READY = Promise.all(
  ['ja', 'es', 'pt'].map(function(lang) {
    return fetch('i18n/' + lang + '.json').then(function(r) { return r.json(); });
  })
).then(function(results) {
  window.I18N = { ja: results[0], es: results[1], pt: results[2] };
});
