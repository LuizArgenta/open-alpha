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
have to be ours at all: the engine is designed to work just as well over
someone else's textbook, lessons and tests. A school does not have to replace
what it already uses.

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
- **The pedagogical metadata is recorded but unused.** Each item stores the
  misconception behind each wrong option — and no query reads it yet. Three
  mistakes from one misunderstanding and three unrelated mistakes currently
  produce the same diagnosis.
- **No self-service export or deletion**, and no defined retention period. See
  [what this stores about you](https://open-alpha-eta.vercel.app/data).
- **No school layer.** No classes, no roster, no teacher queue.

---

## For Students

**Learn at your own pace with an AI tutor that actually understands you.**

1. **Sign up** with your email and grade level
2. **Pick a subject** - Math, Reading, or Science
3. **Chat with your tutor** - Ask questions, work through problems, get explanations that make sense
4. **Show what you know** - Take short quizzes to prove you've mastered a concept
5. **Keep going** - Unlock new concepts as you progress

The AI tutor adjusts to your grade level. A 3rd grader learning fractions gets different explanations than a 7th grader. Stuck on something? Just ask - the tutor will try a different approach.

---

## For Parents

**Stay connected to your child's learning without hovering.**

1. **Create a parent account**
2. **Link to your child** using a simple invite code they generate
3. **See their progress** - Which subjects they're working on, what they've mastered, where they might need help
4. **Get coaching** - Chat with an AI that helps you support your child's learning at home

You can see what your child is learning, but you can't do their work for them. The parent coach gives you practical tips - like how to make math practice fun or what questions to ask about their reading.

---

## Why Open Alpha?

**Learning should be personal.** Every student learns differently. AI tutoring adapts to each student instead of forcing everyone through the same lessons.

**Parents want to help.** But not everyone knows how to explain long division or help with reading comprehension. The parent coach bridges that gap.

**Education shouldn't break the bank.** Open Alpha runs on free infrastructure tiers. No venture capital, no pressure to monetize your children's data.

---

## Subjects Available

- **Mathematics** - From counting to calculus, adapted to grade level
- **Algebra 1** - Variables, equations, functions, and graphing
- **Reading & Language Arts** - Comprehension, vocabulary, writing skills
- **Science** - Biology, chemistry, physics, earth science basics
- **Computer Science** - Programming concepts, algorithms, data structures
- **Accounting & Bookkeeping** - Financial records, statements, the language of business
- **Personal Tax & Finance** - Taxes, budgeting, investing basics
- **Artificial Intelligence** - How AI systems work, prompt engineering, ethics
- **Marketing** - Strategy, branding, consumer behaviour

Subjects with pre-authored lessons load instantly. Newer subjects generate lessons on-demand via AI on first visit and cache them for everyone after — usually 15–30 seconds the first time, instant on every subsequent load.

---

## How Mastery Works

Students don't just click through lessons. They demonstrate understanding:

1. Learn a concept through conversation with the AI tutor
2. When ready, take a 5-question quiz
3. Score 80% or higher to "master" the concept
4. Mastered concepts unlock the next topics

This isn't about speed - it's about actually understanding the material before moving on.

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
Yes. Open Alpha runs on free hosting and database tiers. The AI is powered by ATXP, which provides generous free usage.

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
| AI | OpenAI-compatible endpoint (currently the ATXP gateway) |
| Hosting | Vercel, or a container anywhere (`Dockerfile` + `server/`) |

The handlers are plain functions over the Web `Request`/`Response` types, so
they run under Vercel's file-based routing *and* under `server/routes.ts`,
which reproduces that mapping in one Node process. Nothing about the API is
tied to a hosting provider.

### Local Development

```bash
# Clone the repo
git clone https://github.com/LuizArgenta/open-alpha.git
cd open-alpha

# Install dependencies
npm install

# Set up environment variables
# Create .env files with your TURSO and ATXP credentials

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
- `ATXP_CONNECTION_STRING` - ATXP LLM Gateway credentials
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
