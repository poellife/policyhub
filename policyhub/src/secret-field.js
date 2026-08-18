/* =====================================================================
   Encryption for the two or three fields that genuinely need it.

   A Social Security number or an EIN is not like the rest of the record.
   It has no analytical use here — it exists so a K-1 can be issued — and
   the damage from losing one is done to the investor rather than to the
   firm. So it is encrypted before it reaches the database, decrypted only
   when somebody with the authority asks for it, and every such request is
   written to the audit log.

   AES-256-GCM: the tag makes the ciphertext tamper-evident, which matters
   because a silently altered tax number is worse than a missing one.

   THE KEY
   -------
   `TAXID_KEY` (32 bytes, hex or base64) is the key. If it is not set the
   key is derived from SESSION_SECRET instead, which keeps a development
   or first-deploy instance working without a second secret to manage —
   but it ties the two together, so rotating SESSION_SECRET would make
   stored numbers unreadable. Which key was used is recorded next to each
   value, so a later migration can tell them apart rather than guessing.

   Set TAXID_KEY in production. Generate one with:
       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ===================================================================== */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function readKey() {
  const raw = String(process.env.TAXID_KEY || '').trim();
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (buf.length !== KEY_LENGTH)
      throw new Error('TAXID_KEY must be 32 bytes — 64 hex characters, or base64 of 32 bytes.');
    return { key: buf, id: 'k1' };
  }
  const session = String(process.env.SESSION_SECRET || '');
  if (!session)
    throw new Error('Neither TAXID_KEY nor SESSION_SECRET is set, so a tax number cannot be '
      + 'stored safely. Refusing to store it in the clear.');
  // A distinct info string, so this key can never collide with the one the
  // session cookies are signed with even though both come from the same seed.
  const derived = Buffer.from(
    hkdfSync('sha256', Buffer.from(session), Buffer.alloc(0),
      Buffer.from('policyhub:taxid:v1'), KEY_LENGTH));
  return { key: derived, id: 's1' };
}

/** Encrypt. Returns null for an empty value rather than encrypting nothing. */
export function sealField(plain) {
  const text = String(plain ?? '').trim();
  if (!text) return null;
  const { key, id } = readKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    ciphertext: `${iv.toString('base64')}.${body.toString('base64')}.${
      cipher.getAuthTag().toString('base64')}`,
    keyId: id,
  };
}

/**
 * Decrypt. Returns null rather than throwing when the value cannot be read —
 * a rotated key should make a tax number unavailable, not make the investor's
 * whole record fail to load.
 */
export function openField(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [iv, body, tag] = String(ciphertext).split('.');
    if (!iv || !body || !tag) return null;
    const { key } = readKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** The digits, with no formatting — what gets encrypted and counted. */
export const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

/** "•••-••-6789" for a nine-digit number, "••-•••6789" for an EIN. */
export function maskTaxId(last4, kind = '') {
  if (!last4) return '';
  return /ein|tax|entity/i.test(kind) ? `••-•••${last4}` : `•••-••-${last4}`;
}
