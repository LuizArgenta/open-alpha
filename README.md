# Open Alpha

**An open learning engine that works out what a student needs, does the smallest
thing that helps, and checks whether it worked.**

Try it now: **[open-alpha-eta.vercel.app](https://open-alpha-eta.vercel.app)**

---

## What is Open Alpha?

Most learning software is a place you go. Open Alpha is meant to be a layer of
judgement over learning wherever it already happens.

It watches what a student actually does — every answer, how long it took, which
wrong option they picked — forms an estimate of what they know, decides the
smallest useful intervention, and then measures whether that intervention
worked.

```
evidence → what they know → decision → intervention → outcome
    ↑                                                    │
    └────────────────────────────────────────────────────┘
```

A lesson is one kind of intervention. So is a hint, a worked example, a short
practice set, a question that probes a suspicion, a link to the school's own
textbook, or a nudge telling a teacher that this student needs five minutes of
a human being's attention.

**The goal is not to keep anyone in the app.** It is to close the gap with the
least intervention necessary and hand the student back to whatever they were
doing.

**The content is not ours, in two senses.** It is not proprietary: the
curriculum graph is open and collaborative, it grows over time, and it is meant
to be populated by teachers — and eventually by AI at scale. And it does not
have to be ours at all. The engine is designed to work equally well over four
sources: existing open corpora (Wikipedia, Wikidata, open curriculum
standards), peer-reviewed contributions, a school's own textbook and tests, and
model generation. A school does not have to replace what it already uses.

Open corpora are the fastest route to scale, with one asymmetry worth stating:
an encyclopedia is excellent at *explaining* and has almost nothing to say about
*assessing*. It has no distractors, and no record of which misconception each
wrong answer represents. So open content moves explanation coverage a long way
and assessment coverage barely at all.

The bigger prize is grounding. Today 94% of the curriculum is generated from
nothing, which is where the risk of a confidently wrong lesson lives. A model
that *adapts* verified open material instead of inventing it hallucinates less,
solves the reading-level problem — an eight-year-old cannot read the Wikipedia
article on fractions — and leaves something citable behind when a parent asks
where an explanation came from.

Read the architecture this is heading towards in
[docs/PRD-v3-motor-de-intervencao.md](./docs/PRD-v3-motor-de-intervencao.md)
(Portuguese), including an honest list of what does not work yet.

No subscriptions. No ads. Just learning.

---

## Where it actually is today

This is an experimental platform being tested with consenting adults. It is not
ready for children, and the README should not pretend otherwise.

**Works, and is tested:** quizzes graded on the server (never by the browser),
every attempt tied to an immutable snapshot of the items it showed, mastery and
spaced review, error-type diagnosis, a focus signal the learner can dispute, a
decision log, parent linking, XP tied to evidence, versioned migrations that
refuse to start half-applied, backup and restore, a spending ceiling on model
calls, and rate-limited authentication.

**Does not work yet, and is on the roadmap:**

- **Content coverage is 6%.** Of 141 concepts, 9 have authored mastery checks.
  The other 94% generate their questions from a language model on demand.
- **The contribution pipeline does not reach students.** Teachers can submit
  lessons and questions, reviewers can approve them — and an approved
  contribution sits at `approved` forever. Nothing publishes it. Closing that
  last step is what turns the collaborative graph from an intention into a
  fact.
- **Nothing records where content came from.** There is no `source`, `url`,
  `license` or `attribution` field anywhere in the curriculum model. That was
  untidy while everything was ours or generated; it becomes a licensing
  obligation the moment open corpora are ingested, since CC BY-SA requires
  attribution.
- **The pedagogical metadata is recorded but unused.** Each item stores the
  misconception behind each wrong option — and no query reads it yet. Three
  mistakes from one misunderstanding and three unrelated mistakes currently
  produce the same diagnosis.
- **No self-service export or deletion**, and no defined retention period. See
  [what this stores about you](https://open-alpha-eta.vercel.app/data).
- **No school layer.** No classes, no roster, no teacher queue.

---

## What the engine actually does

The parts below describe the machinery, not a feature list. Today it is exercised
through a tutor chat and a quiz; both are interventions, and neither is the point.

### Evidence

Every answer is graded **on the server**, against the item as it was stored when
the attempt opened — the browser is never asked what the score was, and never
told the right answer until after the learner commits. Each attempt is tied to an
immutable, content-hashed snapshot of exactly the questions it showed, so a
mastery decision made a year ago can still be reconstructed from the evidence
that produced it.

Alongside correctness, the engine records how long each answer took, and whether
a quiz was abandoned mid-way — because "found it hard" and "walked away" need
different responses and look identical in a score.

### Knowledge state

Per learner and skill: a mastery estimate, how much evidence it rests on, when
that evidence last arrived, and when the concept is due to be checked again.
Mastery does not decay silently — a concept that was mastered and then failed is
rescheduled, not quietly forgotten.

*Not there yet: a real confidence estimate (it is currently a constant), and any
record of which misconception a learner keeps repeating.*

### Decision

From that state the engine decides what should happen next, and **writes down
why**. Every decision — the review interval, the diagnosis, the XP, the
remediation — is stored with the signals behind it, in the same transaction that
stores its consequences. A decision that lands without its justification would be
worse than one that fails.

A learner who is told they were rushing can disagree, and the disagreement is
kept as part of the record rather than discarded.

### Intervention

Currently: an explanation from the tutor, a hint, a quiz, or being sent back to a
prerequisite. The architecture treats these as instances of one thing, so that a
worked example, a diagnostic probe, a link to the school's own material, or five
minutes of a teacher's attention can be chosen on the same footing — and compared
on the same evidence.

*Not there yet: interventions as a first-class entity. This is the next contract
change.*

### Outcome

Whether the intervention worked, fed back as new evidence. The measurement that
matters most — checking internal estimates against an assessment the engine did
**not** author — is designed and not built. Until it exists, the system can only
mark its own homework.

---

## For students and parents

A student signs up with an email and a grade level, works through concepts with a
tutor that adapts its explanations to that level, and demonstrates understanding
on a short quiz — 80% to master a concept, which then unlocks what depends on it.

A parent creates their own account and links to a learner with an invite code the
learner generates. They can see progress and get coaching on how to help at home;
they cannot do the work, and nobody sees a learner's record without an accepted
link.

Nine subjects are available — mathematics, algebra, reading, science, computer
science, accounting, personal finance, AI and marketing. Nine of 141 concepts
have authored quizzes; the rest generate them on first visit and cache them.

---

## Subjects

Mathematics · Algebra 1 · Reading & Language Arts · Science · Computer Science ·
Accounting & Bookkeeping · Personal Tax & Finance · Artificial Intelligence ·
Marketing

Concepts with authored content load instantly. The rest are generated on first
visit and cached for everyone after — usually 15–30 seconds once, then instant.

---

## Getting Started

### Students
1. Go to [open-alpha-eta.vercel.app](https://open-alpha-eta.vercel.app)
2. Click "Sign Up"
3. Choose "I'm a Student"
4. Enter your email, create a password, and select your grade
5. Start learning!

### Parents
1. Go to [open-alpha-eta.vercel.app](https://open-alpha-eta.vercel.app)
2. Click "Sign Up"
3. Choose "I'm a Parent"
4. Create your account
5. Ask your child to generate an invite code from their dashboard
6. Enter the code to link your accounts

---

## Questions?

**Is this free?**
Yes. Open Alpha runs on free hosting and database tiers, with a spending ceiling
on model calls. The engine talks to any OpenAI-compatible endpoint — this
deployment happens to use the ATXP gateway, which is a configuration choice, not
part of what Open Alpha is.

**Is my child's data safe?**
Not yet suitable for children — see "Where it actually is today" above. For
adults testing it, [/data](https://open-alpha-eta.vercel.app/data) lists every
table, what is kept and why, in plain language: it says that the system forms
judgements about you, that conversations go to a third-party model provider,
and that self-service export and deletion do not exist yet. We don't sell data
or show ads.

**What ages is this for?**
Kindergarten through 12th grade. The AI adapts its language and difficulty to the student's grade level.

**Can I use this for homeschooling?**
Absolutely. Open Alpha works great as a supplement to any curriculum.

**My child is struggling with a concept. What do I do?**
Check their progress in your parent dashboard, then chat with the parent coach for specific strategies. The coach can see what concepts your child is working on and suggest ways to help.

---

## Open Source

Open Alpha is open source. You can see exactly how it works, suggest improvements, or run your own instance.

**Repository**: [github.com/LuizArgenta/open-alpha](https://github.com/LuizArgenta/open-alpha)

---

## Technical Details

*For developers and curious folks.*

### Architecture

| Component | Technology |
|-----------|------------|
| Frontend | React + Vite |
| API | Handlers in `api/`, taking a Web `Request` and returning a `Response` |
| Database | libsql — a local SQLite file, or Turso |
| AI | Any OpenAI-compatible endpoint — this deployment uses the ATXP gateway |
| Hosting | Vercel, or a container anywhere (`Dockerfile` + `server/`) |

The handlers are plain functions over the Web `Request`/`Response` types, so
they run under Vercel's file-based routing *and* under `server/routes.ts`,
which reproduces that mapping in one Node process. Nothing about the API is
tied to a hosting provider.

**No model vendor belongs in the pedagogy.** The engine should ask for a
*capability* — explain, hint, classify an error, generate an item, evaluate an
open response — and let a policy decide which provider and model answers, per
learner, course or organisation. That separation is designed and not yet built:
today every call goes through one chokepoint in `api/_lib/llm.ts`, which is the
right shape but still names a single endpoint and model.

### Local Development

```bash
# Clone the repo
git clone https://github.com/LuizArgenta/open-alpha.git
cd open-alpha

# Install dependencies
npm install

# Set up environment variables
# JWT_SECRET and a database URL are required; see below

# Run locally
npm run dev
```

### Project Structure

```
open-alpha/
├── api/                  # Vercel serverless functions
│   ├── _lib/            # Shared utilities (db, auth, llm)
│   ├── auth/            # Login, signup, session
│   ├── tutor/           # Student AI chat, quizzes
│   ├── coach/           # Parent AI chat
│   ├── parent/          # Child linking, progress viewing
│   └── progress/        # Student progress tracking
├── server/              # Runs the same handlers as one Node process
├── scripts/             # Backup, restore, snapshot
├── curriculum/          # Authored subjects and concepts (JSON)
├── tests/               # 370 tests, run in UTC-3 on purpose
├── frontend/            # React application
│   ├── src/pages/       # Route components
│   └── src/components/  # Shared UI
└── docs/                # PRDs, architecture, execution plan
```

### Environment Variables

For production (Vercel):
- `TURSO_DATABASE_URL` - Your Turso database URL
- `TURSO_AUTH_TOKEN` - Turso authentication token
- `ATXP_CONNECTION_STRING` - Credentials for the model endpoint. The client is
  plain OpenAI-compatible; the endpoint URL and model id are currently constants
  in `api/_lib/llm.ts`, which is a known limitation — pointing the engine at a
  local or institutional endpoint is a roadmap item, not a config change.
- `JWT_SECRET` - Secret for signing auth tokens
- `ADMIN_INIT_KEY` - Key for database initialization endpoint
- `CURRICULUM_REQUIRE_DATABASE` - Set to `true` to refuse to start when the
  curriculum cannot be read from the database. Off by default so a fresh
  install boots on the seed files; a school in operation should turn it on,
  because teaching from a curriculum nobody published is worse than an
  outage. Either way, `GET /api/health/curriculum` answers 503 while the
  instance is degraded.
- `CURRICULUM_REFRESH_SECONDS` - How often a running instance checks whether
  the published curriculum has moved on (default 30). The check is one small
  aggregate query and never blocks a request; publishing forces the instance
  that served the publish to reload immediately.

Spending and kill switches, all optional:

- `LLM_DAILY_TOKEN_BUDGET` - Ceiling on model tokens over a rolling 24 hours,
  counted in the database because serverless has no shared memory. Unset means
  no ceiling, which production warns about once.
- `LLM_ENABLED=false` - Stops all generation, for when the answer to a runaway
  bill is "stop".
- `DEMO_MODE_ENABLED=false` - Closes the anonymous demo endpoint on its own,
  without taking the tutor away from the people actually testing.

Running as a container (`Dockerfile` + `server/`), `JWT_SECRET` is required and
`TURSO_DATABASE_URL` is required in production — the server reports every
missing variable at once and refuses to boot, because a database defaulting to
a file *inside* the container works until the first redeploy takes every
account with it. `HEALTHCHECK` reads `/api/health/schema`, which answers 503
while a migration is unfinished.

### Contributing

Start with [docs/PRD-v3-motor-de-intervencao.md](./docs/PRD-v3-motor-de-intervencao.md)
for where the architecture is going and the ordered PR queue, and
[docs/PLANO-DE-EXECUCAO.md](./docs/PLANO-DE-EXECUCAO.md) for what is done, what
is open, and what turned out to be wrong along the way. Both are in Portuguese.
[ROADMAP.md](./ROADMAP.md) and [TODO.md](./TODO.md) predate them and are kept
for history.

Pull requests welcome. The one convention worth knowing: a change is not done
until something would fail if it broke.

---

*Built with Claude Code*
