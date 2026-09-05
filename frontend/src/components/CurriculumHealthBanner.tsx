import { useEffect, useState } from 'react';
import { useAuth } from '../App';
import { useTranslation } from '../i18n';

interface Health {
  ok: boolean;
  origin: 'database' | 'files';
  degraded: boolean;
  reason?: 'database_empty' | 'database_error';
  error?: string;
  subjects: number;
  concepts: number;
}

/**
 * Says out loud when this instance is serving the seed files instead of the
 * published curriculum.
 *
 * It sits on the curriculum admin page because that is where someone can
 * actually do something about it — re-run the import, or call whoever owns the
 * database. Everything an admin sees below this banner while it is showing
 * (subjects, concepts, versions) describes a database the students are not
 * being taught from.
 */
export default function CurriculumHealthBanner() {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health/curriculum', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(setHealth)
      .catch(() => {/* the banner is a warning, not a dependency */});
  }, [token]);

  if (!health?.degraded) return null;

  const reasonKey = health.reason === 'database_error'
    ? 'curriculumHealth.databaseError'
    : 'curriculumHealth.databaseEmpty';

  return (
    <div
      className="card"
      role="status"
      style={{
        gridColumn: '1 / -1',
        borderLeft: '4px solid var(--error)',
        background: 'color-mix(in srgb, var(--error) 8%, transparent)',
      }}
    >
      <strong style={{ display: 'block', marginBottom: '0.25rem' }}>
        {t('curriculumHealth.title')}
      </strong>
      <p style={{ margin: 0, fontSize: '0.875rem' }}>{t(reasonKey)}</p>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        {t('curriculumHealth.serving', { subjects: health.subjects, concepts: health.concepts })}
      </p>
      {health.error && (
        <pre style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', whiteSpace: 'pre-wrap' }}>
          {health.error}
        </pre>
      )}
    </div>
  );
}
