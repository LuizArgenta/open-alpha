/**
 * What this deployment stores about a person, in the person's terms.
 *
 * Kept as data in a module of its own, rather than as prose inside the page,
 * for two reasons. `tests/data-notice.test.ts` holds it against the real
 * schema — a notice that quietly falls out of date is worse than none, because
 * it is a promise nobody is keeping and the person it was written for has no
 * way to tell. And that test runs under the root tsconfig, which knows nothing
 * about JSX, so the claims have to live somewhere the server side can read
 * without dragging a React page along.
 *
 * Adding a table to the database fails that test until the table is either
 * described here or declared to hold nothing about a person.
 */
export interface StoredData {
  /** The database table, so the claim can be checked against the schema. */
  table: string;
  what: string;
  why: string;
}

export const WHAT_IS_STORED: StoredData[] = [
  {
    table: 'users',
    what: 'Your email address, the name you choose to display, your role, and your grade level. Your password is stored only as a hash, never as text.',
    why: 'To let you sign in and to pick material at the right level.',
  },
  {
    table: 'progress',
    what: 'How well you have done on each concept, how many attempts you made, and when a review is due.',
    why: 'To decide what to show you next and when to bring something back.',
  },
  {
    table: 'assessment_attempts',
    what: 'Every quiz you open: which concept, when you started, when you finished, and the score.',
    why: 'A mastery score has to be traceable to the attempt that produced it.',
  },
  {
    table: 'assessment_responses',
    what: 'Every answer you give — which option you chose, whether it was right, and how long you took.',
    why: 'The score is computed from these on the server, and how long you took feeds the judgement below.',
  },
  {
    table: 'learning_events',
    what: 'When you start and finish a lesson, ask for a hint, or leave a quiz idle.',
    why: 'To tell "found it hard" apart from "walked away", which need different responses.',
  },
  {
    table: 'learning_decisions',
    what: 'What the system decided about you and the signals it used — including judgements like "was rushing" or "was distracted".',
    why: 'So a decision about you can be questioned. This is kept precisely so that it can be shown to you rather than only acted on.',
  },
  {
    table: 'intervention_runs',
    what: 'Each time the system decided to offer you something after a quiz you did not pass: what it offered, why, what it expected that to achieve, and whether it worked.',
    why: 'So the platform can be held to what it predicted rather than to what it explains afterwards — and so you can see the same thing it uses to judge itself.',
  },
  {
    table: 'focus_contests',
    what: 'When you disagree with one of those judgements and say so.',
    why: 'Your disagreement is part of the record, not a discarded click.',
  },
  {
    table: 'sessions',
    what: 'The full text of your conversations with the tutor and the coach.',
    why: 'So a conversation can continue where it left off. These are sent to a language model to generate replies.',
  },
  {
    table: 'user_interests',
    what: 'Interests you enter — hobbies, sports, media, people you admire, careers.',
    why: 'To use examples that mean something to you. You entered these, and you can delete them.',
  },
  {
    table: 'xp_awards',
    what: 'Points awarded, and the attempt each one came from.',
    why: 'So points are traceable to work you actually did.',
  },
  {
    table: 'parent_links',
    what: 'Which adult is linked to which learner, and whether the invitation was accepted.',
    why: 'A guardian can see a linked learner\'s record. Nobody sees it without an accepted link.',
  },
  {
    table: 'auth_attempts',
    what: 'Failed sign-in and sign-up attempts: when, and a one-way hash of the email or IP they were made with — never the address itself. Successful sign-ins are not recorded here, and your own clears the count.',
    why: 'So a password cannot be guessed at the speed of the network. Kept only for the few minutes the limit looks back, then swept.',
  },
  {
    table: 'guest_sessions',
    what: 'If you use the demo without an account: your messages, and a one-way hash of your IP address — never the address itself.',
    why: 'To keep the demo usable without letting one visitor exhaust it for everyone.',
  },
];
