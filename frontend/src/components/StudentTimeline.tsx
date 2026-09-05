import { useEffect, useState } from 'react';
import { useAuth } from '../App';
import { useServerText, useTranslation } from '../i18n';

interface AttemptEvent {
  type: 'attempt';
  at: string;
  subject: string;
  kind: 'mastery' | 'placement';
  conceptId: string;
  conceptName: string;
  score: number | null;
  answered: number;
  correct: number;
  attemptId: number;
}

interface DecisionEvent {
  type: 'decision';
  at: string;
  subject: string | null;
  conceptId: string | null;
  conceptName: string | null;
  kind: string;
  decision: string;
  reason: string;
}

type TimelineEvent = AttemptEvent | DecisionEvent;

const KIND_COLOR: Record<string, string> = {
  next_concept: 'var(--primary)',
  remediation: '#f59e0b',
  diagnosis: 'var(--text-light)',
  review_schedule: 'var(--success)',
  xp_award: 'var(--success)',
  override: '#a855f7',
};

function formatTime(at: string): string {
  const date = new Date(at.includes('T') ? at : at.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export default function StudentTimeline({ childId }: { childId: number }) {
  const { token } = useAuth();
  const { t } = useTranslation();
  const serverText = useServerText();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/parent/children/${childId}/timeline`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => (res.ok ? res.json() : { events: [] }))
      .then(data => {
        if (!cancelled) setEvents(data.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });

    return () => {
      cancelled = true;
    };
  }, [childId, token]);

  if (!events) return null;

  return (
    <div className="card">
      <h4 style={{ fontWeight: 600, marginBottom: '0.75rem' }}>{t('timeline.title')}</h4>

      {events.length === 0 ? (
        <p style={{ fontSize: '0.875rem', color: 'var(--text-light)' }}>{t('timeline.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {events.map((event, index) => (
            <li
              key={`${event.type}-${index}`}
              style={{
                borderLeft: `3px solid ${
                  event.type === 'attempt' ? 'var(--border)' : KIND_COLOR[event.kind] ?? 'var(--border)'
                }`,
                paddingLeft: '0.75rem',
              }}
            >
              <div style={{ fontSize: '0.875rem' }}>
                {event.type === 'attempt'
                  ? `${t(
                      event.kind === 'placement' ? 'timeline.placementAttempt' : 'timeline.attempt',
                      {
                        concept: event.conceptName,
                        correct: event.correct,
                        answered: event.answered,
                      }
                    )}${event.score !== null ? ` · ${t('timeline.attemptScore', { score: event.score })}` : ''}`
                  : serverText(
                      `timeline.decision.${event.kind}`,
                      { concept: event.conceptName ?? '', decision: event.decision },
                      event.decision
                    )}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                {formatTime(event.at)}
                {event.type === 'decision' &&
                  ` · ${serverText(`timeline.reason.${event.reason}`, undefined, event.reason)}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
