import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../App';
import { pluralKey, useTranslation } from '../i18n';
import Spinner from '../components/Spinner';

interface ProbeItem {
  conceptId: string;
  question: string;
  options: string[];
}

export default function Placement() {
  const { subject } = useParams<{ subject: string }>();
  const { token } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [items, setItems] = useState<ProbeItem[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<{ conceptId: string; chosen: string }[]>([]);
  const [placedCount, setPlacedCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/tutor/placement/${subject}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => res.json())
      .then(data => {
        setAvailable(data.available !== false);
        setItems(data.items ?? []);
      })
      .catch(() => setItems([]));
  }, [subject, token]);

  async function choose(option: string) {
    const item = items![index];
    const next = [...answers, { conceptId: item.conceptId, chosen: option.charAt(0) }];
    setAnswers(next);

    if (index < items!.length - 1) {
      setIndex(index + 1);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/tutor/placement/${subject}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: next }),
      });
      const data = await res.json();
      setPlacedCount(data.placed?.length ?? 0);
    } catch {
      setPlacedCount(0);
    } finally {
      setSubmitting(false);
    }
  }

  if (!items) return <Spinner size="large" text={t('common.loading')} />;
  if (submitting) return <Spinner size="large" text={t('placement.submitting')} />;

  const card = {
    maxWidth: '520px',
    margin: '3rem auto',
    padding: '0 1rem',
  } as const;

  if (!available || items.length === 0) {
    return (
      <div style={card}>
        <div className="card">
          <p style={{ marginBottom: '1rem' }}>{t('placement.unavailable')}</p>
          <button className="btn btn-primary" onClick={() => navigate(`/learn/${subject}`)}>
            {t('placement.goLearn')}
          </button>
        </div>
      </div>
    );
  }

  if (placedCount !== null) {
    return (
      <div style={card}>
        <div className="card">
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            {t('placement.doneTitle')}
          </h2>
          <p style={{ marginBottom: '1.25rem', lineHeight: 1.6 }}>
            {placedCount === 0
              ? t('placement.placedNone')
              : t(pluralKey('placement.placed', placedCount), { count: placedCount })}
          </p>
          <button className="btn btn-primary" onClick={() => navigate(`/learn/${subject}`)}>
            {t('placement.goLearn')}
          </button>
        </div>
      </div>
    );
  }

  const item = items[index];

  return (
    <div style={card}>
      <div className="card">
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-light)', marginBottom: '0.75rem' }}>
          {t('placement.question', { current: index + 1, total: items.length })}
        </p>
        <h3 style={{ fontSize: '1.0625rem', fontWeight: 500, lineHeight: 1.6, marginBottom: '1.25rem' }}>
          {item.question}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {item.options.map(option => (
            <button
              key={option}
              onClick={() => choose(option)}
              style={{
                textAlign: 'left',
                padding: '0.875rem',
                borderRadius: '0.5rem',
                border: '2px solid var(--border)',
                background: 'var(--surface)',
                cursor: 'pointer',
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
