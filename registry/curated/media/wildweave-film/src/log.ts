/**
 * @module @framers/agentos-ext-wildweave-film/log
 *
 * The pack's logger: pino, JSON lines to stderr (stdout is the MCP protocol's channel under
 * stdio), one child `{ module: 'wildweave-film-mcp' }`. A key never reaches a line: the
 * `authorization` field and every field whose name holds `key` or `token` are redacted, and any
 * string of a studio key's shape (`wld_live_...`), or the configured key itself, is masked in
 * every message and field.
 */
import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** A studio key's shape: `wld_live_` and its secret part. */
const KEY_SHAPE = /wld_live_[A-Za-z0-9_-]+/g;

/** A field whose value is a credential by its name alone. */
const SECRET_FIELD = /authorization|key|token|secret|password/i;

/** Fields named like a credential that hold no secret: a count, a flag or an id the lines need. */
const SAFE_FIELDS = new Set(['keyId', 'keyEnv', 'hasKey']);

const MASK = '[redacted]';

/** The text with every key-shaped string, and each of `secrets`, masked. */
export function maskKeys(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(KEY_SHAPE, `wld_live_${MASK}`);
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(MASK);
  }
  return out;
}

/** A copy of the value with every string masked and every credential-named string field redacted. */
export function maskDeep(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') return maskKeys(value, secrets);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    out[field] = typeof item === 'string' && SECRET_FIELD.test(field) && !SAFE_FIELDS.has(field) ? MASK : maskDeep(item, secrets, depth + 1);
  }
  return out;
}

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /** pino's level; `info` by default. */
  level?: string;
  /** Where the lines go; stderr (fd 2) by default. */
  destination?: DestinationStream;
  /** Values masked wherever they appear: the configured key. */
  secrets?: readonly string[];
}

/** The pack's logger, writing to stderr unless a destination is given. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const secrets = (options.secrets ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const root = pino(
    {
      level: options.level ?? 'info',
      base: undefined,
      redact: { paths: ['authorization', '*.authorization', 'headers.authorization', 'key', '*.key', 'token', '*.token'], censor: MASK },
      formatters: {
        log: (fields) => maskDeep(fields, secrets) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const masked = args.map((arg) => (typeof arg === 'string' ? maskKeys(arg, secrets) : arg));
          return (method as (...rest: unknown[]) => void).apply(this, masked);
        },
      },
    },
    options.destination ?? pino.destination(2),
  );
  return root.child({ module: 'wildweave-film-mcp' });
}
