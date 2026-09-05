import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../App';
import { pluralKey, useTranslation } from '../i18n';
import Spinner from '../components/Spinner';

interface ProbeItem {
  itemId: number;
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
  // The attempt is the whole submission: which concept an answer counts for is
  // the server's record, not something the page gets to assert.
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [placedCount, setPlacedCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    fetch(`/api/tutor/placement/${subject}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => res.json())
      .then(data => {
        setAvailable(data.available !== false);
        setItems(data.items ?? []);
        setAttemptId(data.attemptId ?? null);
      })
      .catch(() => setItems([]));
  }, [subject, token]);

  async function choose(option: string) {
    const item = items![index];

    // Graded and recorded one item at a time, through the same endpoint the
    // mastery check uses.
    const answered = await fetch('/api/tutor/quiz/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId, itemId: item.itemId, chosen: option.charAt(0) }),
    });

    if (answered.status === 410) {
      setExpired(true);
      return;
    }
    if (!answered.ok) return; // let them try again rather than losing the item

    if (index < items!.length - 1) {
      setIndex(index + 1);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/tutor/placement/${subject}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId }),
      });
      if (res.status === 410) {
        setExpired(true);
        return;
      }
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

  if (expired) {
    return (
      <div style={card}>
        <div className="card">
          <p style={{ marginBottom: '1rem' }}>{t('placement.expired')}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('quiz.expiredRestart')}
          </button>
        </div>
      </div>
    );
  }

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
