// Sealed box for notification credentials: Vercel encrypts with the push worker's public key and can never decrypt.
// X25519 (fresh ephemeral key per record) → HKDF-SHA256 → AES-256-GCM, with the account id bound in as AAD so a
// box cannot be replayed under another account. Shared by the API (seal) and the VM worker (open). node:crypto only.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const info = Buffer.from('kampus-push v1');
const publicKeyObject = x => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });

// Private key string is "d.x" (both base64url), so the worker can rebuild the JWK without extra files.
export function workerKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey: jwk.d + '.' + jwk.x };
}

function deriveKey(shared, ephemeralX, workerX) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephemeralX + '.' + workerX), info, 32));
}

export function sealForWorker(workerPublicKey, account, payload) {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralX = ephemeral.publicKey.export({ format: 'jwk' }).x;
  const key = deriveKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyObject(workerPublicKey) }), ephemeralX, workerPublicKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(account));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['v1', ephemeralX, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function openSealed(workerPrivateKey, account, box) {
  const [version, ephemeralX, iv, body, tag] = String(box).split('.');
  if (version !== 'v1' || !tag) throw new Error('bad_box');
  const [d, x] = workerPrivateKey.split('.');
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d, x }, format: 'jwk' });
  const key = deriveKey(diffieHellman({ privateKey, publicKey: publicKeyObject(ephemeralX) }), ephemeralX, x);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(account));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
}

// Signature for API → worker sync messages: HMAC over the exact body, which carries its own timestamp.
export function signBody(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function verifyBody(secret, body, signature, now = Date.now(), maxAge = 60_000) {
  if (!secret || secret.length < 32 || typeof signature !== 'string') return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const ts = JSON.parse(body).ts;
  return Number.isFinite(ts) && Math.abs(now - ts) <= maxAge;
}
