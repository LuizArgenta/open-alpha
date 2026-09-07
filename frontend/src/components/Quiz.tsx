import { useState, useEffect } from 'react';
import { useAuth } from '../App';
import Spinner from './Spinner';
import { useServerText, useTranslation } from '../i18n';

interface Question {
  itemId: number;
  question: string;
  options: string[];
}

/** What the server says about the answer just given. */
interface Verdict {
  correct: boolean;
  correctAnswer: string;
  explanation: string | null;
}

interface Remediation {
  action: 'review_prerequisites' | 'simpler_explanation' | 'sub_skill' | 'extra_practice';
  /** Authored content, already written in the curriculum's language. */
  message?: string;
  /** Set when the engine synthesised the guidance instead. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  conceptId?: string;
  conceptName?: string;
}

/**
 * What the engine says to do next.
 *
 * The results screen used to infer this: it showed a "review X" button
 * whenever the remediation happened to carry a `conceptId`. So
 * `review_prerequisites` and `sub_skill` got a button and
 * `simpler_explanation` told the student "let's try explaining this
 * differently" and gave them nothing to click. Nobody chose that — it fell
 * out of which fields a shape happened to have.
 */
interface NextAction {
  type: 'study_concept' | 'review_prerequisite' | 'micro_lesson'
      | 'simpler_explanation' | 'practice';
  reason: string;
  conceptId?: string;
  conceptName?: string;
  interventionRunId?: string;
  policyVersion: number;
}

interface QuizProps {
  subject: string;
  conceptId: string;
  conceptName: string;
  onComplete: (score: number, passed: boolean) => void;
  onCancel: () => void;
  onReviewLesson?: () => void;
  onRemediate?: (conceptId: string) => void;
}

export default function Quiz({ subject, conceptId, conceptName, onComplete, onCancel, onReviewLesson, onRemediate }: QuizProps) {
  const { token } = useAuth();
  const { t, language } = useTranslation();
  const serverText = useServerText();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const [remediation, setRemediation] = useState<Remediation | null>(null);
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [xp, setXp] = useState<{ amount: number; reason: string } | null>(null);
  const [serverScore, setServerScore] = useState<number | null>(null);
  const [grading, setGrading] = useState(false);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // A quiz left open for hours is closed by the server. Saying so is better
  // than a screen that silently stops responding.
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    fetchQuiz();
  }, [conceptId]);

  async function fetchQuiz() {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/tutor/quiz', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subject, conceptId, language }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate quiz');
      }

      if (data.questions && data.questions.length > 0) {
        setQuestions(data.questions);
        setAttemptId(data.attemptId ?? null);
        // The server records quiz_start itself, from the request that opened
        // the attempt. Reporting it from here as well produced two rows for
        // one event — and the browser's copy was the unreliable one, sent
        // fire-and-forget with its failures swallowed.
      } else {
        throw new Error('No questions received');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('quiz.loadError'));
    } finally {
      setLoading(false);
    }
  }

  async function submitResults() {
    try {
      // The attempt is the whole payload: the score is the server's to
      // compute from the answers it graded.
      const res = await fetch('/api/tutor/quiz/submit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attemptId }),
      });

      if (res.status === 410) {
        setExpired(true);
        return;
      }

      const data = await res.json();
      if (data.masteryScore !== undefined) setServerScore(data.masteryScore);
      if (data.remediation) setRemediation(data.remediation);
      if (data.nextAction) setNextAction(data.nextAction);
      if (data.xp) setXp(data.xp);
    } catch (error) {
      console.error('Failed to submit results:', error);
    }
  }

  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());

  // Reset timer when moving to a new question
  useEffect(() => {
    setQuestionStartTime(Date.now());
  }, [currentIndex]);

  /**
   * The browser no longer knows the answer, so it asks. The round trip is
   * what makes the score trustworthy; the feedback arrives with the reply.
   */
  async function handleAnswer(answer: string) {
    if (showExplanation || grading) return;

    setSelectedAnswer(answer);
    setGrading(true);

    const responseTimeMs = Date.now() - questionStartTime;

    try {
      const res = await fetch('/api/tutor/quiz/answer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId,
          itemId: questions[currentIndex].itemId,
          chosen: answer,
          responseTimeMs,
        }),
      });

      if (res.status === 410) {
        setExpired(true);
        return;
      }

      if (!res.ok) throw new Error('grading failed');

      const result = await res.json() as Verdict;
      setVerdict(result);
      setShowExplanation(true);
      if (result.correct) setCorrectCount(prev => prev + 1);
    } catch {
      // Let them try again rather than recording an answer nobody graded.
      setSelectedAnswer(null);
    } finally {
      setGrading(false);
    }
  }

  /** Everything about the old attempt is gone; start a clean one. */
  function restart() {
    setExpired(false);
    setFinished(false);
    setQuestions([]);
    setCurrentIndex(0);
    setSelectedAnswer(null);
    setShowExplanation(false);
    setVerdict(null);
    setCorrectCount(0);
    setRemediation(null);
    setXp(null);
    setServerScore(null);
    fetchQuiz();
  }

  function handleNext() {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setSelectedAnswer(null);
      setShowExplanation(false);
      setVerdict(null);
    } else {
      setFinished(true);
      submitResults();
    }
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size="large" text={t('quiz.generating')} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div className="card" style={{ textAlign: 'center', maxWidth: '400px' }}>
          <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{error}</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button onClick={fetchQuiz} className="btn btn-primary">
              {t('common.tryAgain')}
            </button>
            <button onClick={onCancel} className="btn btn-outline">
              {t('common.goBack')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div className="card" style={{ textAlign: 'center', maxWidth: '420px' }}>
          <h2 style={{ marginBottom: '0.75rem' }}>{t('quiz.expiredTitle')}</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('quiz.expiredBody')}</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button onClick={restart} className="btn btn-primary">{t('quiz.expiredRestart')}</button>
            <button onClick={onCancel} className="btn btn-secondary">{t('quiz.backToLearning')}</button>
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    // The server's number, not a local tally, so what is shown is what was
    // recorded.
    const score = serverScore ?? Math.round((correctCount / questions.length) * 100);
    const passed = score >= 80;

    /**
     * One button, chosen by what the engine decided rather than by which
     * fields came back filled in.
     *
     * `simpler_explanation` is the case that had nothing before: the student
     * was told the concept would be explained another way and left with no way
     * to see it, even though `onReviewLesson` was already wired for the
     * mid-quiz path. Falls back to the old inference when `nextAction` is
     * absent, so a client talking to an older server still works.
     */
    const actionButton = (() => {
      if (nextAction) {
        switch (nextAction.type) {
          case 'review_prerequisite':
          case 'micro_lesson':
            if (!nextAction.conceptId || !onRemediate) return null;
            return {
              label: nextAction.conceptName
                ? t('quiz.reviewConcept', { concept: nextAction.conceptName })
                : t('quiz.reviewEarlier'),
              onClick: () => onRemediate(nextAction.conceptId!),
            };
          case 'simpler_explanation':
            if (!onReviewLesson) return null;
            return { label: t('quiz.explainDifferently'), onClick: onReviewLesson };
          case 'practice':
          case 'study_concept':
            // Nothing to send them elsewhere for: the button below already
            // takes them back to this concept.
            return null;
        }
      }

      if (remediation?.conceptId && onRemediate) {
        return {
          label: remediation.conceptName
            ? t('quiz.reviewConcept', { concept: remediation.conceptName })
            : t('quiz.reviewEarlier'),
          onClick: () => onRemediate(remediation.conceptId!),
        };
      }
      return null;
    })();

    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div className="card" style={{ textAlign: 'center', maxWidth: '400px' }}>
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              background: passed ? 'var(--success)' : 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
              color: 'white',
              fontSize: '2rem',
            }}
          >
            {passed ? '★' : score}
          </div>

          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            {passed ? t('quiz.passedTitle') : t('quiz.failedTitle')}
          </h2>

          <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
            {t('quiz.scored', { score })}
          </p>

          <p style={{ color: 'var(--text-light)', marginBottom: '1rem' }}>
            {t('quiz.correctCount', { correct: correctCount, total: questions.length })}
          </p>

          {xp && (
            <div style={{ marginBottom: '1.5rem' }}>
              {xp.amount > 0 && (
                <div style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--success)' }}>
                  {t('xp.earned', { amount: xp.amount })}
                </div>
              )}
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-light)' }}>
                {serverText(`xp.reason.${xp.reason}`)}
              </div>
            </div>
          )}

          {passed ? (
            <p style={{ color: 'var(--success)', marginBottom: '1.5rem' }}>
              {t('quiz.mastered', { concept: conceptName })}
            </p>
          ) : remediation ? (
            <div style={{
              marginBottom: '1.5rem',
              padding: '0.875rem 1rem',
              borderRadius: '0.5rem',
              background: 'rgba(99, 102, 241, 0.08)',
              border: '1px solid var(--primary)',
              textAlign: 'left',
            }}>
              <p style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                {t('quiz.whatToDoNext')}
              </p>
              <p style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>
                {serverText(remediation.messageKey, remediation.messageParams, remediation.message)}
              </p>
            </div>
          ) : (
            <p style={{ color: 'var(--text-light)', marginBottom: '1.5rem' }}>
              {t('quiz.needMore')}
            </p>
          )}

          {!passed && actionButton && (
            <button
              onClick={actionButton.onClick}
              className="btn btn-primary"
              style={{ width: '100%', marginBottom: '0.75rem' }}
            >
              {actionButton.label}
            </button>
          )}

          <button
            onClick={() => onComplete(score, passed)}
            className={!passed && actionButton ? 'btn btn-outline' : 'btn btn-primary'}
            style={{ width: '100%' }}
          >
            {passed ? t('quiz.continueLearning') : t('quiz.backToLearning')}
          </button>
        </div>
      </div>
    );
  }

  const question = questions[currentIndex];
  const isCorrect = verdict?.correct ?? false;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1.5rem', overflow: 'auto' }}>
      {/* Progress dots */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
          {questions.map((_, i) => (
            <div key={i} style={{
              height: '8px',
              width: i === currentIndex ? '20px' : '8px',
              borderRadius: '4px',
              background: i < currentIndex ? 'var(--success)' : i === currentIndex ? 'var(--primary)' : 'var(--border)',
              transition: 'all 0.2s ease',
              flexShrink: 0,
            }} />
          ))}
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-light)', marginLeft: '0.375rem' }}>
            {currentIndex + 1}/{questions.length}
          </span>
        </div>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-light)', cursor: 'pointer', fontSize: '0.875rem' }}>
          {t('common.cancel')}
        </button>
      </div>

      {/* Question */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 500, lineHeight: 1.6 }}>{question.question}</h3>
      </div>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {question.options.map((option, index) => {
          const letter = option.charAt(0);
          const isSelected = selectedAnswer === letter;
          const isCorrectOption = showExplanation && letter === verdict?.correctAnswer;

          let background = 'var(--surface)';
          let borderColor = 'var(--border)';

          if (showExplanation) {
            if (isCorrectOption) {
              background = 'rgba(34, 197, 94, 0.1)';
              borderColor = 'var(--success)';
            } else if (isSelected && !isCorrectOption) {
              background = 'rgba(239, 68, 68, 0.1)';
              borderColor = 'var(--error)';
            }
          } else if (isSelected) {
            borderColor = 'var(--primary)';
          }

          return (
            <button
              key={index}
              onClick={() => handleAnswer(letter)}
              disabled={showExplanation || grading}
              style={{
                textAlign: 'left',
                padding: '1rem',
                borderRadius: '0.5rem',
                border: `2px solid ${borderColor}`,
                background,
                cursor: showExplanation ? 'default' : 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {option}
            </button>
          );
        })}
      </div>

      {/* Explanation */}
      {showExplanation && (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            background: isCorrect ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${isCorrect ? 'var(--success)' : 'var(--error)'}`,
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
            {isCorrect ? t('quiz.correct') : t('quiz.incorrect')}
          </p>
          <p>{verdict?.explanation}</p>
          {!isCorrect && onReviewLesson && (
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(239,68,68,0.25)' }}>
              <button
                onClick={onReviewLesson}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--primary)', fontWeight: 500, fontSize: '0.875rem',
                  padding: 0,
                }}
              >
                {t('quiz.reviewLesson')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Next Button */}
      {showExplanation && (
        <button onClick={handleNext} className="btn btn-primary" style={{ alignSelf: 'flex-end' }}>
          {currentIndex < questions.length - 1 ? t('quiz.nextQuestion') : t('quiz.seeResults')}
        </button>
      )}
    </div>
  );
}
