import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';

function encryptionKey() {
  return createHash('sha256').update(env.REGISTRATION_DATA_ENCRYPTION_KEY ?? env.JWT_SECRET).digest();
}

export function encryptPrivateAddress(address: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const addressCiphertext = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return {
    addressCiphertext: addressCiphertext.toString('base64'),
    addressIv: iv.toString('base64'),
    addressTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptPrivateAddress(profile: { addressCiphertext?: string | null; addressIv?: string | null; addressTag?: string | null }) {
  if (!profile.addressCiphertext || !profile.addressIv || !profile.addressTag) return null;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(profile.addressIv, 'base64'));
  decipher.setAuthTag(Buffer.from(profile.addressTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(profile.addressCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}