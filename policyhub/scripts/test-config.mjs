/* =====================================================================
   Test credentials, read from the environment — never from source.

   Nothing in this repository should contain a password that works
   anywhere. Each suite asks for the accounts it needs and fails with a
   readable message if they are missing, rather than falling back to a
   default that would end up committed.

   Put them in `.env.test` (git-ignored) or export them in your shell:

     TEST_BASE=http://localhost:3000
     TEST_ADMIN_EMAIL=…        TEST_ADMIN_PASSWORD=…
     TEST_MANAGER1_EMAIL=…     TEST_MANAGER1_PASSWORD=…
     TEST_MANAGER2_EMAIL=…     TEST_MANAGER2_PASSWORD=…
     TEST_INVESTOR1_EMAIL=…    TEST_INVESTOR1_PASSWORD=…
     TEST_INVESTOR2_EMAIL=…    TEST_INVESTOR2_PASSWORD=…

   `scripts/make-sample-data.js` writes a ready-made `.env.test` for the
   fixture database it builds. See `.env.test.example`.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env reader — no dependency, and it never overwrites a real
// environment variable, so an export on the command line always wins.
for (const file of ['.env.test', '.env.test.local']) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

export const BASE = process.env.TEST_BASE || 'http://localhost:3000';

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `\nMissing ${name}.\n` +
      `Test accounts are read from the environment so that no working password\n` +
      `is ever committed. Copy .env.test.example to .env.test and fill it in,\n` +
      `or run: node scripts/make-sample-data.js --write-env\n`
    );
    process.exit(2);
  }
  return v;
}

/** Lazily resolved so a suite only demands the accounts it actually uses. */
const account = (key) => ({
  get email() { return need(`TEST_${key}_EMAIL`); },
  get password() { return need(`TEST_${key}_PASSWORD`); },
});

/**
 * The database, for the one suite that needs to look inside it.
 *
 * Almost everything here talks to the application over HTTP, which is the
 * right way round — a test that reaches past the API proves the API works
 * only by accident. The exception is the outbox: "a message that fails is
 * retried and then given up on" is a fact about rows, and the only honest
 * way to check it is to look at them.
 */
export function databaseUrl() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '\nMissing TEST_DATABASE_URL.\n' +
      'One suite (mail-test) inspects the outbox directly. Point it at the same\n' +
      'database the server under test is using, in .env.test:\n\n' +
      '  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lifesettle\n'
    );
    process.exit(2);
  }
  return url;
}

export const ADMIN = account('ADMIN');
export const MANAGER1 = account('MANAGER1');
export const MANAGER2 = account('MANAGER2');
export const INVESTOR1 = account('INVESTOR1');
export const INVESTOR2 = account('INVESTOR2');

/** A throwaway password for accounts a suite creates and then deletes. */
export const scratchPassword = (tag) =>
  `${tag}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/** Sign in over the API and return the cookie header for later requests. */
export async function login(email, password, base = BASE) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
