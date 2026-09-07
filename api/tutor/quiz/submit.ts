import { type SqlStatement, type TransactionScope, executeSql, withTransaction } from '../../_lib/db.js';
import { forbidden, getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import {
  MASTERY_THRESHOLD,
  getConcept,
  getConceptWithLesson,
  resolveRemediation,
  toProgressMap,
} from '../../_lib/curriculum.js';
import { type ReviewSchedule, scheduleAfterLapse, scheduleAfterMastery } from '../../_lib/review.js';
import {
  type AnswerEvent,
  attemptFocusScore,
  diagnoseAttempt,
  rapidAnswerThresholdMs,
} from '../../_lib/diagnosis.js';
import { awardXp } from '../../_lib/xp.js';
import { decisionStatement } from '../../_lib/decisions.js';
import { ATTEMPT_DEADLINE_MODIFIER, attemptExpired, expireAttempt } from '../../_lib/attempts.js';
import { recordEvent } from '../../_lib/events.js';
import {
  completeRunStatement,
  findIntervention,
  openRunsFor,
  startRunStatement,
} from '../../_lib/interventions.js';
import {
  type ExpectedOutcome,
  interventionKeyForRemediation,
  judgeRun,
} from '../../_lib/intervention-contract.js';
import { POLICY_VERSION, actionForRemediation } from '../../_lib/next-action.js';

interface AttemptRow {
  student_id: number;
  subject: string;
  concept_id: string;
  finished_at: string | null;
  expired_at: string | null;
  started_at: string;
  stale: number;
}

/**
 * The score, computed from what the server graded and stored — never from
 * what the client reports. Unanswered items count as wrong: skipping a
 * question must not be a way to raise a score.
 */
async function scoreFromStoredAnswers(
  run: TransactionScope['run'],
  attemptId: number
): Promise<{ score: number; answered: number; total: number }> {
  const totals = await run<{ total: number; answered: number; correct: number }>(
    `SELECT
       (SELECT COUNT(*) FROM assessment_attempt_items WHERE attempt_id = $1) as total,
       (SELECT COUNT(*) FROM assessment_responses WHERE attempt_id = $2) as answered,
       (SELECT COALESCE(SUM(correct), 0) FROM assessment_responses WHERE attempt_id = $3) as correct`,
    [attemptId, attemptId, attemptId]
  );

  const total = Number(totals.rows[0]?.total ?? 0);
  const correct = Number(totals.rows[0]?.correct ?? 0);

  return {
    score: total > 0 ? Math.round((correct / total) * 100) : 0,
    answered: Number(totals.rows[0]?.answered ?? 0),
    total,
  };
}

interface Progress {
  mastery_score: number;
  review_interval_days: number | null;
  attempts: number;
}

interface StoredAnswerRow {
  correct: number;
  response_ms: number | null;
  answered_at: string;
  chosen: string | null;
  distractor_error_code: string | null;
}

/**
 * The misunderstanding behind the option this student actually picked.
 *
 * The item stores a map from option label to a code naming why someone would
 * choose it. Undefined here means "not recorded" — the item predates the
 * metadata, or the model named no cause — and never "no shared cause". The
 * diagnosis treats the two differently, which is the whole reason the
 * validation refuses partially-filled codes.
 */
function errorCodeFor(row: StoredAnswerRow): string | undefined {
  if (row.correct === 1 || row.chosen === null || row.distractor_error_code === null) {
    return undefined;
  }
  try {
    const codes = JSON.parse(row.distractor_error_code) as Record<string, string>;
    const code = codes[row.chosen];
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    // A malformed blob is one item without a code, not a failed submission.
    return undefined;
  }
}

/**
 * The answers as the server graded them. This used to read learning_events,
 * whose `correct` flag was whatever the browser posted — so the diagnosis
 * that decides between "rushed" and "has a real gap" was reasoning over the
 * student's own claims.
 */
async function loadAttemptAnswers(
  run: TransactionScope['run'],
  attemptId: number
): Promise<AnswerEvent[]> {
  const rows = await run<StoredAnswerRow>(
    `SELECT r.correct, r.response_ms, r.answered_at, r.chosen,
            item.distractor_error_code
     FROM assessment_responses r
     JOIN assessment_attempt_items i ON i.attempt_id = r.attempt_id AND i.item_id = r.item_id
     JOIN assessment_items item ON item.id = r.item_id
     WHERE r.attempt_id = $1
     ORDER BY i.position`,
    [attemptId]
  );

  return rows.rows.map(row => ({
    correct: row.correct === 1,
    responseTimeMs: row.response_ms ?? undefined,
    at: row.answered_at,
    errorCode: errorCodeFor(row),
  }));
}

interface SubjectProgressRow {
  concept_id: string;
  mastery_score: number;
  attempts: number;
}

/**
 * What the student should do next after failing a mastery check. Without this
 * the only answer the UI can give is "try again", which is the one thing a
 * student who just failed three times should not do.
 */
async function buildRemediation(studentId: number, subject: string, conceptId: string) {
  const concept = await getConceptWithLesson(subject, conceptId);
  if (!concept) return undefined;

  const progressRows = await executeSql<SubjectProgressRow>(
    'SELECT concept_id, mastery_score, attempts FROM progress WHERE student_id = $1 AND subject = $2',
    [studentId, subject]
  );

  const progressById = toProgressMap(
    progressRows.rows.map(row => ({
      conceptId: row.concept_id,
      masteryScore: row.mastery_score,
      attempts: row.attempts,
    }))
  );

  return resolveRemediation(subject, concept, progressById);
}

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    // The attempt is the whole input. Subject, concept and score come from
    // the server's own record of it, so none of them can be asserted by the
    // client any more.
    const body = await request.json() as { attemptId?: number };

    if (!Number.isInteger(body.attemptId)) {
      return Response.json({ error: 'attemptId is required' }, { status: 400 });
    }
    const attemptId = body.attemptId as number;

    const attemptRow = await executeSql<AttemptRow>(
      `SELECT student_id, subject, concept_id, finished_at, expired_at, started_at,
              started_at < datetime('now', $1) as stale
       FROM assessment_attempts WHERE id = $2`,
      [ATTEMPT_DEADLINE_MODIFIER, attemptId]
    );
    if (attemptRow.rows.length === 0) {
      return Response.json({ error: 'Attempt not found' }, { status: 404 });
    }

    const attempt = attemptRow.rows[0];
    if (attempt.student_id !== auth.userId) return forbidden();

    if (attempt.expired_at !== null) return attemptExpired();

    // Finishing twice would award XP twice and re-run the schedule.
    if (attempt.finished_at !== null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    // A quiz opened hours ago and submitted now says nothing about whether the
    // student can do this today, which is what mastery claims. Expired rather
    // than graded: the answers stay as evidence, the decision is not made.
    if (Number(attempt.stale) === 1) {
      await expireAttempt(attemptId);
      return attemptExpired();
    }

    const subject = attempt.subject;
    const conceptId = attempt.concept_id;

    // Read before the transaction because it must not run inside one: it
    // reaches into the curriculum's cached-lesson table through
    // getConceptWithLesson, and a read issued from inside a write transaction
    // runs on another connection that libsql serialises behind this one's
    // lock. Safe to resolve early, and safe to resolve unconditionally: it
    // reads the prerequisites' progress, which this attempt does not touch,
    // and only *whether* it gets used depends on how the attempt went. The
    // cost is two selects on the passing path, which is the cheap half of the
    // trade against holding a write lock open across them.
    const concept = getConcept(subject, conceptId);
    const rapidThresholdMs = rapidAnswerThresholdMs(concept?.metadata?.difficulty);
    const remediationIfFailed = await buildRemediation(auth.userId, subject, conceptId);

    /**
     * The catalogue entry for the intervention this attempt might start.
     *
     * Read out here for the same reason `buildRemediation` is: it is a read,
     * and one issued from inside a write transaction runs on another
     * connection that libsql serialises behind this one's lock. The *open
     * runs* are deliberately not read here — see inside the transaction.
     */
    const catalogue = new Map(await Promise.all(
      ['review_prerequisites', 'sub_skill', 'simpler_explanation', 'extra_practice'].map(
        async action => {
          const key = interventionKeyForRemediation(action)!;
          return [action, await findIntervention(key)] as const;
        }
      )
    ));

    /**
     * Everything below happens after the attempt is claimed, and that order is
     * the point.
     *
     * The score used to be computed out here, before the transaction. An
     * answer arriving in the window between that read and the claim was
     * perfectly legal — the attempt was still open when it was written — and
     * it simply was not counted. The attempt then closed with a score, a
     * mastery decision, XP and a diagnosis all derived from a set of responses
     * smaller than the one sitting in the table. Nothing failed and nothing
     * logged; a student who answered five of five correctly could be recorded
     * at 80%.
     *
     * Claiming first closes that window instead of narrowing it. Once
     * `finished_at` is set, `answer` refuses to insert, so the responses read
     * on the next line are final by construction rather than by timing.
     */
    const outcome = await withTransaction(async scope => {
      const claimed = await scope.run<{ id: number }>(
        `UPDATE assessment_attempts SET finished_at = datetime('now')
         WHERE id = $1 AND finished_at IS NULL RETURNING id`,
        [attemptId]
      );

      // libsql reports rowsAffected as 0 for an UPDATE ... RETURNING, so
      // whether the row was claimed has to come from the returned rows.
      // A second submission of the same attempt loses here, which is what
      // keeps XP from being awarded twice and `attempts` from counting twice.
      if (claimed.rows.length === 0) return null;

      const { score } = await scoreFromStoredAnswers(scope.run, attemptId);
      const answers = await loadAttemptAnswers(scope.run, attemptId);

      const existingProgress = await scope.run<Progress>(
        'SELECT mastery_score, review_interval_days, attempts FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
        [auth.userId, subject, conceptId]
      );

      const priorAttempts = existingProgress.rows[0]?.attempts ?? 0;
      const attemptPassed = score >= MASTERY_THRESHOLD;
      const hasProgress = existingProgress.rows.length > 0;
      const existing = existingProgress.rows[0];
      const wasMastered = hasProgress && existing.mastery_score >= MASTERY_THRESHOLD;

      // Mastery never regresses, so it is this attempt's raw score — not the
      // all-time best — that says whether the concept held up today.
      const newScore = hasProgress ? Math.max(existing.mastery_score, score) : score;
      const passed = newScore >= MASTERY_THRESHOLD;

      const schedule: ReviewSchedule | null = hasProgress
        ? attemptPassed
          ? scheduleAfterMastery(existing.review_interval_days)
          : wasMastered
            ? scheduleAfterLapse()
            : null
        : attemptPassed
          ? scheduleAfterMastery(null)
          : null;
      const scheduleReason = hasProgress ? (attemptPassed ? 'passed' : 'lapsed') : 'first_pass';

      const diagnosis = diagnoseAttempt({ answers, priorAttempts, rapidThresholdMs });

      const xp = awardXp({
        score,
        focusScore: attemptFocusScore(answers, rapidThresholdMs),
        priorAttempts,
        estimatedMinutes: concept?.metadata?.estimatedMinutes,
        gamed: diagnosis.pattern === 'rapid_guessing',
      });

      // Why they failed decides what to offer: a student who rushed or walked
      // away hasn't shown a knowledge gap, so sending them to a prerequisite
      // would be answering the wrong question.
      const remediation = passed
        ? undefined
        : diagnosis.isAttention
          ? {
              action: 'extra_practice' as const,
              messageKey: diagnosis.messageKey,
              messageParams: diagnosis.messageParams,
            }
          : remediationIfFailed;

      const writes: SqlStatement[] = [];

      writes.push({
        sql: 'UPDATE assessment_attempts SET score = $1 WHERE id = $2',
        params: [score, attemptId],
      });

      if (hasProgress) {
        // The WHERE clause's placeholder numbers depend on how many the SET
        // clause consumed above them — hardcoding $4/$5/$6 there silently
        // misbound them (or grabbed the wrong argument) whenever `schedule` was
        // absent and the params array was four items, not six.
        const updateParams: unknown[] = [newScore];
        let updateSql = `UPDATE progress SET mastery_score = $1, attempts = attempts + 1, last_attempt_at = datetime('now'), mastery_source = 'quiz', mastery_confidence = 1.0`;
        if (passed) updateSql += `, completed_at = datetime('now')`;
        if (schedule) {
          updateParams.push(schedule.modifier, schedule.intervalDays);
          updateSql += `, next_review_at = datetime('now', $${updateParams.length - 1}), review_interval_days = $${updateParams.length}`;
        }
        updateParams.push(auth.userId, subject, conceptId);
        updateSql += ` WHERE student_id = $${updateParams.length - 2} AND subject = $${updateParams.length - 1} AND concept_id = $${updateParams.length}`;

        writes.push({ sql: updateSql, params: updateParams });
      } else {
        writes.push({
          sql: `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at, mastery_source, mastery_confidence${passed ? ', completed_at' : ''}${schedule ? ', next_review_at, review_interval_days' : ''})
         VALUES ($1, $2, $3, $4, 1, datetime('now'), 'quiz', 1.0${passed ? ", datetime('now')" : ''}${schedule ? ", datetime('now', $5), $6" : ''})`,
          params: schedule
            ? [auth.userId, subject, conceptId, score, schedule.modifier, schedule.intervalDays]
            : [auth.userId, subject, conceptId, score],
        });
      }

      if (xp.amount !== 0) {
        writes.push({
          sql: 'INSERT INTO xp_awards (student_id, subject, concept_id, attempt_id, amount, reason) VALUES ($1, $2, $3, $4, $5, $6)',
          params: [auth.userId, subject, conceptId, attemptId, xp.amount, xp.reason],
        });
      }

      // The decisions ride along in the same transaction rather than being
      // logged best-effort afterwards: they are the grounds for the rows above,
      // and a parent contesting a remediation is owed the record of it. A write
      // that lands without its justification is worse than one that fails.
      if (schedule) {
        writes.push(
          decisionStatement({
            studentId: auth.userId,
            subject,
            conceptId,
            kind: 'review_schedule',
            decision: `+${schedule.intervalDays}d`,
            reason: scheduleReason,
            inputs: { score, priorAttempts },
          })
        );
      }

      writes.push(
        decisionStatement({
          studentId: auth.userId,
          subject,
          conceptId,
          kind: 'diagnosis',
          decision: diagnosis.pattern,
          reason: passed ? 'passed' : 'failed',
          // The misconception rides along: a decision about someone has to be
          // contestable, and "you made the same mistake twice" is the part
          // they would want to see.
          inputs: {
            score,
            answers: answers.length,
            rapidThresholdMs,
            ...(diagnosis.misconception ? { misconception: diagnosis.misconception } : {}),
          },
        })
      );

      writes.push(
        decisionStatement({
          studentId: auth.userId,
          subject,
          conceptId,
          kind: 'xp_award',
          decision: String(xp.amount),
          reason: xp.reason,
          inputs: { score, estimatedMinutes: concept?.metadata?.estimatedMinutes },
        })
      );

      /**
       * Interventions still waiting on a result, judged against this attempt.
       *
       * The prediction was written when the run began — "this student, at 40
       * on this concept, should reach 80 on their next attempt" — so scoring
       * it here compares against something recorded in advance rather than a
       * story told afterwards. That is the difference between this table and
       * telemetry.
       *
       * Read inside the transaction, not before it. Two attempts on the same
       * concept submitted close together would otherwise both see the same
       * open run and each start a replacement, leaving two open runs for a
       * later attempt to credit with one outcome. `scope.run` is this
       * transaction's own connection, which is what makes the read safe here
       * where a bare `executeSql` would deadlock behind its lock.
       */
      const awaitingResult = await openRunsFor(scope.run, auth.userId, subject, conceptId);
      let startedRunId: string | undefined;

      /**
       * And only attempts that *began after* the intervention can say anything
       * about it.
       *
       * A learner can open two quizzes on a concept, answer both, then submit
       * them in order: the first failure starts a run, and the second — whose
       * answers were given before that run existed — would be recorded as its
       * outcome. That is not a weak signal, it is the wrong one, and it would
       * corrupt exactly the comparison this table is for. A run that cannot be
       * judged stays open and waits for an attempt that can.
       *
       * Strictly after, on a clock with one-second granularity, so an attempt
       * opened in the very second a run began is not judged against it. That
       * errs toward waiting: a run judged one attempt later costs a little
       * latency, a run judged by an attempt that predates it costs the truth
       * of every comparison drawn from this table afterwards.
       */
      const judgeable = awaitingResult.filter(run => run.startedAt < attempt.started_at);

      for (const run of judgeable) {
        writes.push(completeRunStatement(run.id, judgeRun(run.expectedOutcome, {
          score,
          attention: diagnosis.isAttention,
        })));
      }

      for (const write of writes) {
        await scope.run(write.sql, write.params);
      }

      /**
       * The remediation decision and the intervention run it starts, written
       * last and together.
       *
       * Out of the `writes` list because the run has to name the decision that
       * chose it, and that id only exists once the decision row is written —
       * a challenge to one has to reach the other. Same transaction as
       * everything above, for the reason the decisions already ride along: a
       * write that lands without its justification is worse than one that
       * fails.
       */
      if (!passed) {
        const decision = await scope.run<{ id: number }>(
          `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason, inputs)
           VALUES ($1, $2, $3, 'remediation', $4, $5, $6) RETURNING id`,
          [
            auth.userId,
            subject,
            conceptId,
            remediation?.conceptId ?? remediation?.action ?? 'none',
            diagnosis.pattern,
            // policyVersion: which rulebook chose this. Without it, decisions
            // recorded either side of a rule change cannot be told apart, and
            // comparing their outcomes compares two different things.
            JSON.stringify({ score, priorAttempts, policyVersion: POLICY_VERSION }),
          ]
        );

        const key = remediation ? interventionKeyForRemediation(remediation.action) : undefined;
        const intervention = key ? catalogue.get(remediation!.action) : undefined;

        // One pending intervention per concept. A run left open above is one
        // this attempt could not judge; stacking another on top of it would
        // produce two runs that the next attempt resolves identically, which
        // is a comparison of nothing against itself.
        const stillPending = awaitingResult.length > judgeable.length;

        if (intervention && !stillPending) {
          const expectedOutcome: ExpectedOutcome = {
            metric: 'mastery_score',
            subject,
            conceptId,
            baseline: score,
            target: MASTERY_THRESHOLD,
            within: 'next_attempt',
          };

          const start = startRunStatement({
            interventionKey: intervention.key,
            studentId: auth.userId,
            subject,
            conceptId,
            // Where they were sent, when the remediation names somewhere else.
            targetConceptId: remediation?.conceptId,
            reason: diagnosis.pattern,
            evidence: {
              score,
              priorAttempts,
              answers: answers.length,
              ...(diagnosis.misconception ? { misconception: diagnosis.misconception } : {}),
            },
            expectedOutcome,
            decisionId: Number(decision.rows[0].id),
          }, intervention.id);

          await scope.run(start.statement.sql, start.statement.params);
          startedRunId = start.runId;
        }
      }

      return { score, newScore, passed, diagnosis, xp, remediation, startedRunId };
    });

    if (outcome === null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    // Outside the transaction and after it committed: the stream is evidence,
    // not the source of truth, and holding the write lock across it is what
    // PR #46 had to undo.
    await recordEvent({
      studentId: auth.userId,
      subject,
      conceptId,
      type: 'quiz_complete',
      attemptId,
      payload: {
        score: outcome.score,
        passed: outcome.passed,
        diagnosis: outcome.diagnosis.pattern,
        xp: outcome.xp.amount,
        ...(outcome.diagnosis.misconception
          ? { misconception: outcome.diagnosis.misconception }
          : {}),
      },
    });

    if (outcome.passed) {
      return Response.json({
        masteryScore: outcome.newScore,
        passed: outcome.passed,
        message: "Congratulations! You've mastered this concept!",
        xp: outcome.xp,
      });
    }

    /**
     * What the student should do, as an instruction rather than a shape to
     * interpret.
     *
     * `remediation` stays for compatibility, as the PRD says it should. The
     * difference is that the client no longer has to infer intent from which
     * fields happen to be filled in — which is how `simpler_explanation` ended
     * up telling a student "let's try this another way" and offering nothing
     * to click, while `sub_skill` got a button, purely because one carried a
     * conceptId and the other did not.
     */
    const nextAction = actionForRemediation(outcome.remediation, {
      reason: outcome.diagnosis.pattern,
      conceptId,
      interventionRunId: outcome.startedRunId,
    });

    return Response.json({
      masteryScore: outcome.newScore,
      passed: outcome.passed,
      message: 'Keep practicing to reach 80% mastery.',
      diagnosis: outcome.diagnosis.pattern,
      xp: outcome.xp,
      remediation: outcome.remediation,
      nextAction,
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    return Response.json({ error: 'Failed to submit quiz results' }, { status: 500 });
  }
}
