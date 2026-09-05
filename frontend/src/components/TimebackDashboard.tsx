import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../App';
import WasteMeter, { type FocusReason } from './WasteMeter';
import { useTranslation } from '../i18n';

interface TimebackData {
  today: {
    totalActiveMinutes: number;
    lessonMinutes: number;
    quizMinutes: number;
    conceptsStudied: number;
    totalAnswers: number;
    correctAnswers: number;
    hintRequests: number;
  };
  wasteMeter: {
    score: number;
    focusScore: number;
    rapidGuessCount: number;
    idleTimeouts: number;
    walkedAwayCount: number;
    reasons: FocusReason[];
  };
  xp: {
    earnedToday: number;
    dailyGoal: number;
    goalProgress: number;
    goalReached: boolean;
  };
  timeback: {
    dailyProgress: number;
    targetMinutes: number;
    effectiveMinutes: number;
    timebackMinutes: number;
    efficiencyMultiplier: number;
  };
  recentAccuracy: number | null;
}

export default function TimebackDashboard() {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [data, setData] = useState<TimebackData | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/progress/timeback', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // Silently fail — not critical
    }
  }, [token]);

  useEffect(() => {
    load();
    // Refresh every 60 seconds while the component is mounted
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  async function contest(code: FocusReason['code']) {
    try {
      await fetch('/api/progress/contest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: code }),
      });
      await load();
    } catch {
      // Silently fail — not critical
    }
  }

  if (!data) return null;

  const { today, wasteMeter, timeback, xp } = data;
  const isDone = timeback.dailyProgress >= 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* XP: proof of learning, not minutes in the seat */}
      {xp && (
        <div className="card" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontWeight: 600, fontSize: '1.125rem' }}>
              {xp.goalReached ? t('xp.goalReached') : t('xp.title')}
            </h3>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-light)' }}>
              {t('xp.progress', { earned: xp.earnedToday, goal: xp.dailyGoal })}
            </span>
          </div>
          <div style={{ height: '12px', background: 'var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${xp.goalProgress}%`,
              background: xp.goalReached
                ? 'linear-gradient(90deg, var(--success), #34d399)'
                : 'linear-gradient(90deg, var(--primary), #818cf8)',
              borderRadius: '6px',
              transition: 'width 0.5s ease',
            }} />
          </div>
        </div>
      )}

      {/* Timeback Progress */}
      <div className="card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ fontWeight: 600, fontSize: '1.125rem' }}>
            {isDone ? t('timeback.earnedTitle') : t('timeback.earnTitle')}
          </h3>
          <span style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            padding: '0.25rem 0.75rem',
            borderRadius: '9999px',
            background: isDone ? 'var(--success)' : 'var(--primary)',
            color: 'white',
          }}>
            {timeback.dailyProgress}%
          </span>
        </div>

        {/* Progress bar showing how close to "done" */}
        <div style={{ height: '12px', background: 'var(--border)', borderRadius: '6px', overflow: 'hidden', marginBottom: '0.75rem' }}>
          <div style={{
            height: '100%',
            width: `${timeback.dailyProgress}%`,
            background: isDone
              ? 'linear-gradient(90deg, var(--success), #34d399)'
              : 'linear-gradient(90deg, var(--primary), #818cf8)',
            borderRadius: '6px',
            transition: 'width 0.5s ease',
          }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', color: 'var(--text-light)' }}>
          <span>{t('timeback.minutesFocused', { minutes: today.totalActiveMinutes })}</span>
          <span>
            {isDone
              ? t('timeback.minutesEarned', { minutes: timeback.timebackMinutes })
              : t('timeback.minutesRemaining', {
                  minutes: timeback.targetMinutes - timeback.effectiveMinutes,
                })}
          </span>
        </div>

        {timeback.efficiencyMultiplier > 1 && (
          <div style={{
            marginTop: '0.5rem',
            fontSize: '0.75rem',
            color: 'var(--success)',
            fontWeight: 500,
          }}>
            {t('timeback.focusBonus')}
          </div>
        )}
      </div>

      {/* Waste Meter */}
      <div className="card" style={{ padding: '1.25rem' }}>
        <WasteMeter
          focusScore={wasteMeter.focusScore}
          reasons={wasteMeter.reasons ?? []}
          onContest={contest}
        />
      </div>

      {/* Today's Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div className="card" style={{ padding: '0.875rem 1rem', flex: '1 1 120px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1 }}>{today.conceptsStudied}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '0.25rem' }}>{t('timeback.conceptsToday')}</div>
        </div>
        <div className="card" style={{ padding: '0.875rem 1rem', flex: '1 1 120px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1 }}>
            {today.totalAnswers > 0 ? Math.round((today.correctAnswers / today.totalAnswers) * 100) : 0}%
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '0.25rem' }}>{t('timeback.accuracy')}</div>
        </div>
        <div className="card" style={{ padding: '0.875rem 1rem', flex: '1 1 120px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1 }}>{today.hintRequests}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '0.25rem' }}>{t('timeback.hintsUsed')}</div>
        </div>
      </div>
    </div>
  );
}
