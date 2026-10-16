import { z } from 'zod';

/**
 * Environment configuration, validated at boot (docs/35 §2).
 *
 * A service that starts with a missing DATABASE_URL and fails later is worse than one
 * that refuses to start: the failure moves from deploy time (visible, safe) to request
 * time (invisible, user-facing). Validation therefore happens here, once, at startup.
 *
 * This module reads `process.env` only. It never reads a committed file, so secrets can
 * be injected at runtime and rotated without a rebuild (docs/17).
 */

/** Comma-separated origin list → validated array. No wildcard in production. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().url()).min(1, 'CORS_ORIGIN must list at least one origin'));

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),

  // Which tier this process runs (`docs/03` §6/§7, `docs/34` §4).
  //   - `all`    — HTTP **and** the schedulers. The honest default for one developer box.
  //   - `api`    — HTTP only. The schedulers belong to a worker workload, because a worker
  //                must not serve HTTP (`docs/03` §3) and `N` API instances each scheduling
  //                is the classic horizontal-scaling defect (`docs/03` J5).
  //   - `worker` — the schedulers only, no HTTP listener.
  // A process that is asked to be both tiers at once is misconfigured; each entrypoint
  // refuses rather than starting the wrong one.
  PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanish.default('false'),

  DATABASE_URL: z.string().url(),

  // Transaction queueing (`docs/33` §4: "timeouts ... set, so a stuck query releases its
  // connection"). `maxWait` is how long a transaction may queue for a pooled connection
  // before it fails; `timeout` bounds the transaction itself. Both are explicit and
  // bounded, and the default `maxWait` of 2 s is not: a burst of concurrent writes — 500
  // parallel request creates is a stated acceptance criterion of `docs/22` §14 — queues
  // past it and every queued write fails at once, which is a self-inflicted outage rather
  // than back-pressure.
  DB_TRANSACTION_MAX_WAIT_MS: z.coerce.number().int().positive().default(10_000),
  DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Optional locally: the cache/queue provider is Redis (`ADR-0003`). When absent, the
  // app degrades to database reads and defers delivery (docs/33 §16) rather than
  // failing. It is required in a deployed environment (docs/35 §2).
  REDIS_URL: z.string().url().optional(),

  CORS_ORIGIN: originList,

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // Authentication endpoints carry a materially tighter bucket than the application
  // baseline (docs/33 §6): credential stuffing is cheap, so the credential surface must
  // be the most expensive to brute-force.
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Session signing/derivation secret (`ADR-0001` uses server-side sessions).
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),

  // Session lifecycle (`ADR-0001`, docs/06 §7). Both bounds apply: a session dies at
  // the idle timeout OR at the absolute maximum, whichever comes first. Names are
  // configurable so an environment can adopt a prefix without a code change.
  SESSION_COOKIE_NAME: z.string().min(1).default('servicehub_session'),
  CSRF_COOKIE_NAME: z.string().min(1).default('servicehub_csrf'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

  // Lockout (`docs/06 §6`): N consecutive failures lock the account for a period.
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // Invitation/onboarding (`docs/06 §11`, `ADR-0012`).
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // Incident reopen window (`docs/23` §4 rule I4): a RESOLVED/CLOSED incident may be
  // reopened without an override reason only within this many hours of resolution.
  INCIDENT_REOPEN_WINDOW_HOURS: z.coerce.number().int().positive().default(72),

  // SLA sweep cadence (`docs/25` §6). Worst-case breach detection delay equals this
  // interval, so it is chosen as a small fraction of the shortest target.
  SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // Redis cache region TTLs (`docs/33 §5`). Every region has an explicit, bounded TTL
  // (rule C2); a short session-lookup TTL is a defence-in-depth bound on staleness,
  // with explicit invalidation on revocation as the primary control.
  SESSION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  // Catalog cache regions (`docs/21 §10`, `docs/33 §5.1`). The category tree is the
  // long region (minutes–hours), the active item list the medium one (minutes); both
  // are explicitly bounded (C2) and invalidated by every catalog mutation in the same
  // pathway as the write (C3, `docs/21 §12` AC5).
  CATALOG_CATEGORY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  CATALOG_ITEM_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // Password policy (`docs/06 §4`): minimum length 12, bounded at 128 to cap work.
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(12).max(128).default(12),
  PASSWORD_MAX_LENGTH: z.coerce.number().int().min(12).max(128).default(128),

  // Argon2id parameters — docs/06 §4 mandates memory ≥ 64 MiB and iterations ≥ 3.
  // 65_536 KiB = 64 MiB; these are the floor, tuned upward at deploy if capacity allows.
  ARGON2_MEMORY_COST: z.coerce.number().int().min(65_536).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(3).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Email provider (`ADR-0006` chooses SendGrid). The adapter sends via the SendGrid
  // Web API when this key is present; without it, development records a logged send and
  // production refuses to boot (see the cross-field rule below).
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_API_BASE_URL: z.string().url().default('https://api.sendgrid.com'),

  // Outbox drain (`docs/29` §3). Worst-case delivery delay equals the interval; the
  // retry backoff is bounded exponential (`docs/29` N7) and dead-letters at the cap.
  NOTIFICATION_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  NOTIFICATION_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  NOTIFICATION_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),

  // Dashboard aggregate cache (`docs/30` §3.4: "dashboard aggregates — short TTL,
  // invalidated on write of that class"). The TTL is the hard bound on staleness for a
  // write that does not arrive through a mutation — the SLA sweep's breach stamp is the
  // real case — and it is deliberately short: a dashboard that is minutes behind is a
  // dashboard nobody trusts, and the aggregates it caches are indexed reads.
  REPORT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  // Async report exports (`docs/30` §3.1/§3.4): the result is a time-limited download.
  REPORT_EXPORT_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  REPORT_EXPORT_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(20),
  REPORT_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),

  // Outbound webhooks (`docs/32` §4/§8). Delivery is async off the request path; a failed
  // delivery is retried with bounded exponential backoff and then dead-lettered. The
  // timeout is explicit — a webhook call never waits forever (`docs/32` §8).
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WEBHOOK_FANOUT_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),
  WEBHOOK_DELIVERY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Inbound webhooks (`docs/32` §5). Receive verifies and persists, then acks; a worker
  // processes afterwards. The raw payload is retained for a bounded window for diagnosis,
  // and the signature tolerance is the replay window.
  INBOUND_WEBHOOK_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  INBOUND_WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  INBOUND_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  INBOUND_WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(60_000),
  INBOUND_WEBHOOK_PAYLOAD_TTL_HOURS: z.coerce.number().int().positive().default(72),
  INBOUND_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  // Integration reliability (`docs/32` §8). Every external call runs behind a circuit
  // breaker and a bulkhead; both are per-integration, so one broken remote cannot spend
  // another's capacity. Defaults are conservative — a breaker that never opens is a
  // timeout loop, and one that opens on a single blip is an outage of its own.
  INTEGRATION_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  INTEGRATION_BREAKER_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  INTEGRATION_BREAKER_HALF_OPEN_SUCCESSES: z.coerce.number().int().positive().default(2),
  INTEGRATION_BULKHEAD_MAX_CONCURRENT: z.coerce.number().int().positive().default(10),
  INTEGRATION_BULKHEAD_MAX_QUEUE: z.coerce.number().int().positive().default(200),
  INTEGRATION_BULKHEAD_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Inbound roster sync (`docs/32` §6). Reconciliation is scheduled, batched and resumable;
  // the drift fraction is the share of known people whose disappearance aborts a run instead
  // of silently deactivating them.
  ROSTER_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  ROSTER_SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),
  ROSTER_SYNC_MAX_REMOVAL_FRACTION: z.coerce.number().positive().max(1).default(0.2),

  // File attachments (docs/19 §7.4). The caps are enforced before the body is read and
  // again on the stream, so a lying Content-Length cannot bypass them (docs/19 §7.2 rule 4).
  FILE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  FILE_MAX_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  FILE_MAX_PER_RECORD: z.coerce.number().int().positive().max(100).default(20),

  // Object storage (`ADR-0004`, docs/19 §7.1). `s3` is any S3-compatible endpoint and is
  // the only driver permitted in production — backends keep no file bytes, or a file
  // uploaded to instance 1 is unreadable from instance 2. `local` exists for development
  // and tests, where a single instance and no bucket are the honest reality.
  FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  FILE_STORAGE_DIR: z.string().min(1).default('./storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanish.default('true'),
  /// Lifetime of a signed download URL (docs/19 §7.3): long enough to fetch, short
  /// enough that a leaked link is worthless.
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),

  // The asynchronous antivirus scan step (`docs/19` §7.2 step 7). Unset means no scanner is
  // configured: the content sniff stays the only gate and an upload is promoted on the
  // request path, which is what development and the test suite rely on. Set means uploads
  // land `PENDING` and only this worker makes them retrievable — so a configured-but-broken
  // scanner withholds files rather than serving unscanned bytes (rule 1 of §7.2).
  ANTIVIRUS_URL: z.string().url().optional(),
  ANTIVIRUS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  ANTIVIRUS_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  ANTIVIRUS_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(25),

  // Public base URL of the SPA, used to build invitation links in the email payload.
  // Only ever used server-side to compose a link; it grants no authority (docs/17).
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
});

/**
 * Cross-field rules.
 *
 * The cache/broker is optional locally (the app degrades gracefully — `docs/33` C4) but
 * **required in production** (`docs/35` §2): sessions (`ADR-0001`) and rate-limit
 * counters (`ADR-0003`) must live in a shared store, because per-instance state is
 * wrong behind a load balancer. Failing at boot is far cheaper than discovering on a
 * second instance that every user is logged out.
 */
const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message:
        'REDIS_URL is required in production (ADR-0001/ADR-0003): sessions and rate limits must use a shared store.',
    });
  }

  // A production deployment must be able to actually deliver email (`docs/29` §3).
  // Booting without a provider would silently log every notification instead of sending
  // it, which is precisely the failure the outbox exists to prevent.
  if (env.NODE_ENV === 'production' && !env.SENDGRID_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SENDGRID_API_KEY'],
      message:
        'SENDGRID_API_KEY is required in production (ADR-0006): notifications must be delivered, not logged.',
    });
  }

  // `ADR-0004`: backends keep no file bytes, so local disk is not a production storage
  // backend — it would make uploads instance-local and unrevivable. Failing at boot beats
  // discovering it when a second instance cannot read the first one's uploads.
  if (env.NODE_ENV === 'production' && env.FILE_STORAGE_DRIVER !== 's3') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FILE_STORAGE_DRIVER'],
      message:
        'FILE_STORAGE_DRIVER must be "s3" in production (ADR-0004): backends keep no file bytes.',
    });
  }

  if (env.FILE_STORAGE_DRIVER === 's3') {
    for (const key of [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when FILE_STORAGE_DRIVER is "s3" (ADR-0004).`,
        });
      }
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate the environment. Throws with every problem listed at once, so a
 * misconfigured deploy shows all missing values in one pass instead of one per restart.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}

/** Test and tooling helper — the same schema exposed for fixtures. */
export const schema = envSchema;
