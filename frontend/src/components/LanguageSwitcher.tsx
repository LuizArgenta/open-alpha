import { LANGUAGES, type Language, useTranslation } from '../i18n';

/** Compact language toggle. Reused by the header and the public pages. */
export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      style={{ display: 'flex', gap: '0.125rem', alignItems: 'center' }}
    >
      {LANGUAGES.map(({ id, labelKey }) => {
        const active = language === id;
        return (
          <button
            key={id}
            onClick={() => setLanguage(id as Language)}
            aria-pressed={active}
            style={{
              padding: compact ? '0.15rem 0.4rem' : '0.25rem 0.5rem',
              borderRadius: '0.375rem',
              border: 'none',
              background: active ? 'var(--primary)' : 'transparent',
              color: active ? 'white' : 'var(--text-light)',
              fontSize: compact ? '0.7rem' : '0.75rem',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {id === 'pt-BR' ? 'PT' : 'EN'}
            <span className="sr-only"> {t(labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
