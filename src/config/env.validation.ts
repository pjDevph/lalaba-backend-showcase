/**
 * Startup required-env validation (GAP-P0-012).
 *
 * Called from main.ts before Nest bootstraps. In production a missing
 * required variable aborts startup (fail fast); in dev/test it only warns,
 * so local workflows are unaffected.
 *
 * Deliberately plain process.env (not ConfigService) so it can run before
 * the DI container exists. Keep this list in sync with .env.example.
 */

interface EnvRule {
  key: string;
  /**
   * Alternatives: the rule is satisfied if ANY of these variables is set
   * (defaults to just `key`). Used where prod and dev use different vars.
   */
  anyOf?: string[];
  /** Only required when this returns true (defaults to always). */
  when?: () => boolean;
  note?: string;
}

const isOn = (v: string | undefined): boolean =>
  (v ?? 'off').trim().toLowerCase() === 'on';

const isProd = (): boolean => process.env.NODE_ENV === 'production';

const RULES: EnvRule[] = [
  // Database — in production we always expect the hosted URI.
  {
    key: 'MONGODB_URI_ONLINE',
    when: () => isProd() || isOn(process.env.MONGODB_ONLINE),
    note: 'hosted MongoDB connection string',
  },
  {
    key: 'MONGODB_URI_LOCAL',
    when: () => !isProd() && !isOn(process.env.MONGODB_ONLINE),
    note: 'local Docker MongoDB connection string',
  },

  // Firebase Admin SDK — FirebaseService accepts a raw JSON credential
  // (production) or a key-file path (dev), so any one of the three works.
  {
    key: 'FIREBASE_CREDENTIALS_JSON',
    anyOf: [
      'FIREBASE_CREDENTIALS_JSON',
      'FIREBASE_CREDENTIALS_PATH_ONLINE',
      'FIREBASE_CREDENTIALS_PATH',
    ],
    note: 'Firebase Admin credentials (JSON string or key-file path)',
  },
  {
    key: 'FIREBASE_WEB_API_KEY',
    note: 'Firebase Web API key (token verification)',
  },

  // Payments (Xendit) — always in production, and in dev whenever the real
  // gateway is switched on with XENDIT_ONLINE=on.
  {
    key: 'XENDIT_SECRET_KEY',
    when: () => isProd() || isOn(process.env.XENDIT_ONLINE),
    note: 'Xendit API secret',
  },
  {
    key: 'XENDIT_CALLBACK_TOKEN',
    when: () => isProd() || isOn(process.env.XENDIT_ONLINE),
    note: 'Xendit webhook verification token (top-ups cannot settle without it)',
  },

  // SEC-004/B2 — shared rate-limit storage. Without it the throttler keeps
  // counters in process memory, so limits are per-instance and reset on every
  // deploy. app.module.ts refuses to construct in production without this, but
  // it is listed here too so the failure names the variable alongside every
  // other missing one rather than surfacing alone as a module-init crash.
  {
    key: 'REDIS_URL',
    when: () => isProd(),
    note: 'Render Key Value internal connection URL (redis://…), same region as the API',
  },

  // CORS allow-list. main.ts falls back to `false` (block every cross-origin
  // request) when this is unset, which is the right failure direction but a
  // silent one: the service starts, passes its health check, and the admin
  // panel simply cannot reach it. Required in production so a Render deploy
  // that forgets it aborts at boot with a named variable instead.
  {
    key: 'ALLOWED_ORIGINS',
    when: () => isProd(),
    note: 'comma-separated CORS origins (the admin panel cannot reach the API without it)',
  },

  // Media storage — always Firebase. Local mode points the same provider at the
  // Storage Emulator via FIREBASE_STORAGE_EMULATOR_HOST, so the bucket name is
  // required either way (the emulator namespaces objects by bucket too).
  {
    key: 'FIREBASE_STORAGE_BUCKET',
    note: 'Firebase Storage bucket',
  },
];

export interface EnvValidationResult {
  missing: string[];
  fatal: boolean;
}

export function validateRequiredEnv(): EnvValidationResult {
  const missing = RULES.filter((r) => {
    if (r.when && !r.when()) return false;
    const candidates = r.anyOf ?? [r.key];
    return !candidates.some((k) => process.env[k]?.trim());
  }).map((r) => {
    const name = r.anyOf ? `one of: ${r.anyOf.join(' | ')}` : r.key;
    return `${name}${r.note ? ` (${r.note})` : ''}`;
  });

  return { missing, fatal: isProd() && missing.length > 0 };
}

/** Validate and either throw (production) or warn (dev/test). */
export function assertRequiredEnv(
  log: { warn: (msg: string, ctx?: string) => void } = {
    warn: (m) => console.warn(m),
  },
): void {
  const { missing, fatal } = validateRequiredEnv();
  if (missing.length === 0) return;

  const message = `Missing required environment variables:\n  - ${missing.join('\n  - ')}`;
  if (fatal) {
    throw new Error(`[env] ${message}\nRefusing to start in production.`);
  }
  log.warn(`[env] ${message} (non-fatal outside production)`, 'Bootstrap');
}
