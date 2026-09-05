import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { type Dictionary, type TranslationKey, ptBR } from './pt-BR';
import { en } from './en';

export type Language = 'pt-BR' | 'en';

export const LANGUAGES: { id: Language; labelKey: TranslationKey }[] = [
  { id: 'pt-BR', labelKey: 'language.pt-BR' },
  { id: 'en', labelKey: 'language.en' },
];

const DICTIONARIES: Record<Language, Dictionary> = { 'pt-BR': ptBR, en };

/** Brazilian Portuguese is the product default; English is opt-in. */
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

const STORAGE_KEY = 'open-alpha-language';

function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'pt-BR' || stored === 'en') return stored;
  } catch {
    // Private windows and blocked site data throw on access.
  }
  return DEFAULT_LANGUAGE;
}

export type TranslateParams = Record<string, string | number>;

export function translate(
  language: Language,
  key: TranslationKey,
  params?: TranslateParams
): string {
  const template = DICTIONARIES[language][key] ?? DICTIONARIES[DEFAULT_LANGUAGE][key] ?? key;
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

/**
 * Picks between a singular and a plural key by count. Both languages here
 * split at the same boundary (1 vs. everything else), so one rule covers both.
 */
export function pluralKey(base: TranslationKey, count: number): TranslationKey {
  return (count === 1 ? base : `${base}_plural`) as TranslationKey;
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, params?: TranslateParams) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference is lost on reload, which is better than failing to switch.
    }
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, params) => translate(language, key, params),
    }),
    [language, setLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useTranslation(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useTranslation must be used within LanguageProvider');
  }
  return context;
}

/**
 * Renders a translation key that came from the API. The server sends keys and
 * values rather than sentences, but some text — an authored remediation
 * message, for instance — is content and arrives already written; that case
 * passes a fallback and no key.
 */
export function useServerText(): (
  key: string | undefined,
  params?: TranslateParams,
  fallback?: string
) => string {
  const { language } = useTranslation();

  return useCallback(
    (key, params, fallback) => {
      if (key && key in DICTIONARIES[DEFAULT_LANGUAGE]) {
        return translate(language, key as TranslationKey, params);
      }
      return fallback ?? '';
    },
    [language]
  );
}

/** Grade 0 is kindergarten; the rest are ordinal in both languages. */
export function useGradeLabel(): (gradeLevel: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (gradeLevel: number) =>
      gradeLevel === 0 ? t('grade.kindergarten') : t('grade.nth', { n: gradeLevel }),
    [t]
  );
}
