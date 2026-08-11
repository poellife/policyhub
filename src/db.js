import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Numeric columns come back as strings in node-postgres by default.
// Money here is well within IEEE-754 safe range, so parse to Number for the API.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(1082, (v) => v); // keep DATE as plain YYYY-MM-DD string

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://lcg:lcgdev@localhost:5432/lifesettle';

// Managed Postgres (Render, Railway, Neon, …) expects TLS; a local dev server
// usually has none. Default on that, with PGSSL as an explicit override.
const pgssl = (process.env.PGSSL || '').toLowerCase();
const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const needsSSL =
  pgssl === 'true' ? true :
  pgssl === 'false' ? false :
  /sslmode=require/.test(connectionString) || !isLocalHost;

export const pool = new pg.Pool({
  connectionString,
  ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

export const q = (text, params) => pool.query(text, params);

export async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Seed the first admin user from env on a cold database.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)',
      [email, hash, process.env.ADMIN_NAME || 'Administrator', 'admin']
    );
    console.log(`[init] created first admin user: ${email}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('[init] WARNING: default password "changeme123" — change it after first login.');
    }
  }

  // A default fund so imports without a fund column still work.
  await pool.query(
    `INSERT INTO funds (code, name) VALUES ('LCG2','Life Capital Group 2')
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
