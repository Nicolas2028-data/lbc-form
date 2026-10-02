import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ja from './locales/ja.json';
import pt from './locales/pt.json';
import es from './locales/es.json';

export const LANGS = ['ja', 'pt', 'es'] as const;
export type Lang = (typeof LANGS)[number];

const LANG_KEY = 'lbc_lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang;
  } catch {
    // 保存できない環境では既定値
  }
  const nav = navigator.language.slice(0, 2);
  return (LANGS as readonly string[]).includes(nav) ? (nav as Lang) : 'ja';
}

void i18n.use(initReactI18next).init({
  resources: { ja: { translation: ja }, pt: { translation: pt }, es: { translation: es } },
  lng: initialLang(),
  fallbackLng: 'ja',
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang) {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 保存できなくても切替は有効
  }
}

/** DB の多言語 JSON({ja, pt, es})から現在の言語の文字列を取る */
export function pickName(name: Record<string, string> | null | undefined, lang: string): string {
  if (!name) return '';
  return name[lang] ?? name.ja ?? Object.values(name)[0] ?? '';
}

export default i18n;
