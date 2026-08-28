import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Numeric columns come back as strings in node-postgres by default.
// Money here is well within IEEE-754 safe range, so parse to Number for the API.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(1082, (v) => v); // keep DATE as plain YYYY-MM-DD string

const isProd = process.env.NODE_ENV === 'production';

/* No credential lives in this file, not even a local one.
 *
 * There used to be a development fallback here — a username and password
 * for a localhost database, used when DATABASE_URL was unset outside
 * production. It was harmless in the sense that it reached nothing real,
 * and a liability in every other sense: a scanner cannot tell a throwaway
 * password from a live one, a reader learns a credential this project
 * uses, and "it is only the dev one" is the sentence that precedes most
 * leaked secrets. The address belongs in .env, which is not committed. */
const connectionString = process.env.DATABASE_URL || '';

if (!connectionString)
  throw new Error(
    'DATABASE_URL is not set. Refusing to start.\n'
    + 'Copy .env.example to .env and put your database address in it, '
    + 'or set DATABASE_URL in the environment.');

// Managed Postgres (Render, Railway, Neon, …) expects TLS; a local dev server
// usually has none. Default on that, with PGSSL as an explicit override.
const pgssl = (process.env.PGSSL || '').toLowerCase();
const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const needsSSL =
  pgssl === 'true' ? true :
  pgssl === 'false' ? false :
  /sslmode=require/.test(connectionString) || !isLocalHost;

/**
 * TLS to the database is verified by default. Encrypting without checking who
 * you are encrypting *to* stops a passive eavesdropper but not an active one,
 * which is the attack that matters on a shared network.
 *
 * Two ways to satisfy it:
 *   PGSSLROOTCERT=/path/to/ca.crt   — file path, or
 *   PGSSLROOTCERT_PEM="-----BEGIN…" — the certificate inline, for hosts whose
 *                                     dashboard only lets you paste env vars
 *
 * PGSSLMODE=no-verify turns verification off. It is a deliberate, logged
 * choice for a provider whose certificate is signed by a private CA reachable
 * only over their internal network — not a default.
 */
function sslConfig() {
  if (!needsSSL) return undefined;
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'no-verify' || mode === 'require') {
    console.warn(
      '[db] PGSSLMODE=%s — the database certificate is NOT being verified. ' +
      'The connection is encrypted but not authenticated. Supply PGSSLROOTCERT ' +
      'and remove this setting when you can.', mode
    );
    return { rejectUnauthorized: false };
  }
  const ca = process.env.PGSSLROOTCERT_PEM
    ? process.env.PGSSLROOTCERT_PEM.replace(/\\n/g, '\n')
    : process.env.PGSSLROOTCERT
      ? fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8')
      : undefined;
  return { rejectUnauthorized: true, ca };
}

export const pool = new pg.Pool({
  connectionString,
  ssl: sslConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
});

// A certificate failure is otherwise a wall of OpenSSL jargon; say what to do.
const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
]);
export function explainDbError(e) {
  if (!CERT_ERRORS.has(e?.code)) return null;
  return (
    `Could not verify the database's TLS certificate (${e.code}).\n` +
    `Your provider signs it with a private CA. Either:\n` +
    `  • set PGSSLROOTCERT_PEM to their CA certificate, or\n` +
    `  • set PGSSLMODE=no-verify to accept it unverified (encrypted but not authenticated).`
  );
}

export const q = (text, params) => pool.query(text, params);

export async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Seed the first admin user from env on a cold database.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    // There is no default password. A predictable one on a fresh deployment is
    // an open door for however long it takes somebody to notice.
    let password = process.env.ADMIN_PASSWORD || '';
    let generated = false;
    if (password.length < 10) {
      if (isProd)
        throw new Error(
          password
            ? 'ADMIN_PASSWORD must be at least 10 characters. Refusing to seed the first admin.'
            : 'ADMIN_PASSWORD is not set. Refusing to seed the first admin account with a ' +
              'default password. Set ADMIN_EMAIL and ADMIN_PASSWORD, then start again.'
        );
      password = crypto.randomBytes(15).toString('base64url');
      generated = true;
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)',
      [email, hash, process.env.ADMIN_NAME || 'Administrator', 'admin']
    );
    console.log(`[init] created first admin user: ${email}`);
    if (generated)
      console.log(
        `[init] ADMIN_PASSWORD was not set, so a random one was generated for this\n` +
        `       development database. It is shown once and not stored anywhere else:\n\n` +
        `           ${password}\n`
      );
  }

  // The two owning entities, so imports and the policy form have them from the
  // start. Set the exact legal names in Settings → Owner entities.
  await pool.query(
    `INSERT INTO funds (code, name) VALUES
       ('LCG1','Life Capital Group 1'),
       ('LCG2','Life Capital Group 2')
     ON CONFLICT (code) DO NOTHING`
  );
}

export async function audit(userId, entity, entityId, action, detail = '') {
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, entity, entity_id, action, detail) VALUES ($1,$2,$3,$4,$5)',
      [userId || null, entity, entityId || null, action, String(detail).slice(0, 2000)]
    );
  } catch (e) {
    console.error('audit failed', e.message);
  }
}
