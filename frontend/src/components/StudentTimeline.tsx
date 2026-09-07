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

/**
 * What the engine offered, and what it concluded about it.
 *
 * Two entries per run rather than one. The gap between "offered a review of
 * equivalent fractions, expecting 80" and "concluded it did not work" is the
 * part a parent asking "what is it doing about this?" is actually asking
 * about, and one collapsed row with a verdict hides it.
 */
interface InterventionEvent {
  type: 'intervention';
  at: string;
  phase: 'started' | 'completed';
  subject: string;
  conceptId: string;
  conceptName: string;
  runId: string;
  interventionKey: string;
  interventionType: string;
  source: string;
  reason: string;
  expected: { baseline: number; target: number } | null;
  outcome: string | null;
  observed: number | null;
}

type TimelineEvent = AttemptEvent | DecisionEvent | InterventionEvent;

/** Colour by verdict: a prediction that held reads differently from one that did not. */
const OUTCOME_COLOR: Record<string, string> = {
  met: 'var(--success)',
  not_met: '#f59e0b',
  inconclusive: 'var(--text-light)',
  abandoned: 'var(--text-light)',
};

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

function borderFor(event: TimelineEvent): string {
  if (event.type === 'attempt') return 'var(--border)';
  if (event.type === 'intervention') {
    // An unfinished run is still waiting on an answer, and says so by being
    // the same neutral colour as everything else in progress.
    return event.outcome ? OUTCOME_COLOR[event.outcome] ?? 'var(--border)' : '#f59e0b';
  }
  return KIND_COLOR[event.kind] ?? 'var(--border)';
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
                borderLeft: `3px solid ${borderFor(event)}`,
                paddingLeft: '0.75rem',
              }}
            >
              <div style={{ fontSize: '0.875rem' }}>
                {event.type === 'intervention'
                  ? event.phase === 'started'
                    ? t('timeline.intervention.started', {
                        what: serverText(
                          `timeline.intervention.type.${event.interventionType}`,
                          undefined,
                          event.interventionType
                        ),
                        concept: event.conceptName,
                      }) + (event.expected
                        ? ` · ${t('timeline.intervention.expected', {
                            baseline: event.expected.baseline,
                            target: event.expected.target,
                          })}`
                        : '')
                    : serverText(
                        `timeline.intervention.outcome.${event.outcome}`,
                        { concept: event.conceptName, observed: event.observed ?? '' },
                        event.outcome ?? ''
                      )
                  : event.type === 'attempt'
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
                {event.type === 'intervention' && event.phase === 'started' &&
                  ` · ${serverText(`timeline.reason.${event.reason}`, undefined, event.reason)}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
