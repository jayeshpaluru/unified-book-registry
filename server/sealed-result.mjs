import { createPublicKey, publicEncrypt, randomBytes, createCipheriv, constants } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export function sealResult(value, publicKey) {
  let key;
  try { key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new Error('Invalid session encryption key.'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) {
    throw new Error('Invalid session encryption key.');
  }
  const secret = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const bytes = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, key: publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, secret).toString('base64'),
    iv: iv.toString('base64'), data: bytes.toString('base64') };
}
