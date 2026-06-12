// AES-256-GCM encryption for credentials at rest (portal passwords, OAuth tokens).
// Format on disk:  base64(iv).base64(authTag).base64(ciphertext)
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';

/**
 * Resolve a 32-byte key from the CREDS_ENCRYPTION_KEY env var.
 * Accepts a base64 32-byte key, or any string (hashed to 32 bytes as a fallback).
 */
export function resolveKey(raw = process.env.CREDS_ENCRYPTION_KEY) {
  if (!raw) {
    throw new Error(
      'CREDS_ENCRYPTION_KEY is not set. Generate one: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  // Fallback: derive a stable 32-byte key from an arbitrary passphrase.
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encrypt(plaintext, key = resolveKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(blob, key = resolveKey()) {
  const [ivB64, tagB64, ctB64] = String(blob).split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed ciphertext blob');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Encrypt selected string fields of an object in place, returning a new object. */
export function encryptFields(obj, fields, key = resolveKey()) {
  const out = { ...obj };
  for (const f of fields) if (out[f] != null) out[f] = encrypt(out[f], key);
  return out;
}

export function decryptFields(obj, fields, key = resolveKey()) {
  const out = { ...obj };
  for (const f of fields) if (out[f] != null) out[f] = decrypt(out[f], key);
  return out;
}
