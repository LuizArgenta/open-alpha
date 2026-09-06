/**
 * What has to be set before this container is allowed to serve anyone.
 *
 * Nothing in the repository wrote down which variables a deployment needs;
 * the knowledge lived in whoever configured Vercel. That is fine until it is
 * the thing standing between a working install and a confusing one, so it is
 * written down here — as code that refuses to boot rather than as a list in a
 * README that drifts.
 *
 * Every one of these fails *quietly* if missing, which is why they are worth
 * checking loudly: a missing database URL writes to a container-local file
 * that vanishes on redeploy, and a missing model key turns every generated
 * lesson into a 500 the learner reads as "the site is broken".
 */

interface RequiredVariable {
  name: string;
  why: string;
  /** Only demanded when NODE_ENV=production. */
  productionOnly?: boolean;
}

const REQUIRED: RequiredVariable[] = [
  {
    name: 'JWT_SECRET',
    why: 'signs session tokens; without it nobody can log in and api/_lib/auth.ts refuses to load',
  },
  {
    name: 'TURSO_DATABASE_URL',
    why:
      'where the database lives. Unset, it defaults to file:local.db inside the container — ' +
      'which works until the first redeploy takes every account and every attempt with it. ' +
      'Point it at a mounted volume (file:/data/open-alpha.db) or a Turso URL',
    productionOnly: true,
  },
];

/** Set, but with a value that means the opposite of what someone expects. */
function suspicious(): string[] {
  const warnings: string[] = [];

  if (process.env.NODE_ENV === 'production') {
    const url = process.env.TURSO_DATABASE_URL ?? '';
    if (url.startsWith('file:') && !url.startsWith('file:/')) {
      warnings.push(
        `TURSO_DATABASE_URL is "${url}", a path relative to the working directory. ` +
        'In a container that is almost never a mounted volume, so the data will not survive a redeploy.'
      );
    }
    if (process.env.CURRICULUM_REQUIRE_DATABASE === 'false') {
      warnings.push(
        'CURRICULUM_REQUIRE_DATABASE=false in production: if the curriculum tables are empty ' +
        'or unreadable this instance will teach from the seed files instead of failing.'
      );
    }
    if (!process.env.ADMIN_INIT_KEY) {
      warnings.push(
        'ADMIN_INIT_KEY is unset, so there is no way to grant the first staff role. ' +
        'Set it, create the first admin, then remove it.'
      );
    }
  }

  return warnings;
}

/**
 * Throws with everything that is wrong at once.
 *
 * One variable at a time would mean one failed deploy per variable, which is
 * how a five-minute setup becomes an afternoon.
 */
export function requireEnvironment(): void {
  const production = process.env.NODE_ENV === 'production';
  const missing = REQUIRED.filter(
    variable => (!variable.productionOnly || production) && !process.env[variable.name]
  );

  for (const warning of suspicious()) console.warn(`[config] ${warning}`);

  if (missing.length === 0) return;

  throw new Error(
    ['Refusing to start. Missing required configuration:', '']
      .concat(missing.map(variable => `  ${variable.name} — ${variable.why}`))
      .concat(['', 'See docs/PLANO-DEPLOY-TESTE.md for the full list.'])
      .join('\n')
  );
}
