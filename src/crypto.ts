import crypto from 'node:crypto';

const IV_LENGTH = 12; // AES-GCM recommended

function getKey(): Buffer {
  const key = process.env.VANITY_ENCRYPTION_KEY;
  if (!key) throw new Error('VANITY_ENCRYPTION_KEY not set');
  // Use 32-byte key (base64 or hex supported); if raw string, hash to 32 bytes
  if (/^[A-Fa-f0-9]{64}$/.test(key)) return Buffer.from(key, 'hex');
  if (/^[A-Za-z0-9+/=]{43,45}$/.test(key)) return Buffer.from(key, 'base64');
  return crypto.createHash('sha256').update(key).digest();
}

export function encryptSecret(plain: Uint8Array): Buffer {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptSecret(blob: Buffer): Buffer {
  const key = getKey();
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + 16);
  const enc = blob.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
} 