// Shared crypto primitives. Standard Web APIs only, so this file runs unchanged
// in browsers, Deno (Supabase Edge Functions) and Node 18+ (vitest).

export const KDF_ITERATIONS = 600_000;
export const RECOVERY_KDF_ITERATIONS = 100_000;

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};
const RSA_IMPORT: RsaHashedImportParams = { name: 'RSA-OAEP', hash: 'SHA-256' };
const IV_BYTES = 12;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_BYTES = 20; // 160 bits -> 32 base32 chars

// Resolved at call time: tests install a WebCrypto polyfill after module load.
function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) is not available');
  return c.subtle;
}

// TS 5.7+ distinguishes Uint8Array<ArrayBufferLike> from BufferSource; cast minimally.
function buf(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

// ---------- encoding ----------

export function toB64(b: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new Error('Invalid base64 input');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues is limited to 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

export function randomSaltB64(): string {
  return toB64(randomBytes(16));
}

export function encodeJson(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}

export function decodeJson<T>(b: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(b)) as T;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// ---------- padding ----------

export function pad(b: Uint8Array, size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 4) throw new Error('Invalid pad size');
  if (b.length + 4 > size) {
    throw new Error(`Payload too large to pad: ${b.length} + 4 > ${size}`);
  }
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, b.length, false);
  out.set(b, 4);
  return out;
}

export function unpad(b: Uint8Array): Uint8Array {
  if (b.length < 4) throw new Error('Invalid padded payload: too short');
  const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
  if (len > b.length - 4) throw new Error('Invalid padded payload: bad length');
  for (let i = 4 + len; i < b.length; i++) {
    if (b[i] !== 0) throw new Error('Invalid padded payload: non-zero padding');
  }
  return b.slice(4, 4 + len);
}

// ---------- hashing / KDF ----------

export async function sha256Hex(s: string): Promise<string> {
  const d = await subtle().digest('SHA-256', buf(new TextEncoder().encode(s)));
  return toHex(new Uint8Array(d));
}

async function deriveSplit(
  secret: string,
  saltB64: string,
  iterations: number,
): Promise<{ hex: string; kek: CryptoKey }> {
  const s = subtle();
  const base = await s.importKey('raw', buf(new TextEncoder().encode(secret)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await s.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: buf(fromB64(saltB64)), iterations },
      base,
      512,
    ),
  );
  const kek = await s.importKey('raw', buf(bits.slice(32, 64)), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { hex: toHex(bits.slice(0, 32)), kek };
}

export async function deriveFromPassword(
  password: string,
  saltB64: string,
  iterations: number = KDF_ITERATIONS,
): Promise<{ authSecret: string; kek: CryptoKey }> {
  const { hex, kek } = await deriveSplit(password, saltB64, iterations);
  return { authSecret: hex, kek };
}

// ---------- recovery code ----------

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let chars = '';
  let acc = 0;
  let nbits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    nbits += 8;
    while (nbits >= 5) {
      nbits -= 5;
      chars += CROCKFORD[(acc >> nbits) & 31];
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) chars += CROCKFORD[(acc << (5 - nbits)) & 31];
  return chars.match(/.{1,4}/g)!.join('-');
}

export function normalizeRecoveryCode(s: string): string {
  return s
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export async function deriveFromRecoveryCode(
  code: string,
  saltB64: string,
): Promise<{ recoveryAuth: string; kek: CryptoKey }> {
  const { hex, kek } = await deriveSplit(
    normalizeRecoveryCode(code),
    saltB64,
    RECOVERY_KDF_ITERATIONS,
  );
  return { recoveryAuth: hex, kek };
}

// ---------- AES-GCM framing ----------

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<[string, string]> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plaintext));
  return [toB64(iv), toB64(new Uint8Array(ct))];
}

async function aesDecrypt(key: CryptoKey, ivB64: string, ctB64: string): Promise<Uint8Array> {
  const iv = fromB64(ivB64);
  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length');
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(fromB64(ctB64)));
    return new Uint8Array(pt);
  } catch {
    throw new Error('Decryption failed (wrong key or tampered data)');
  }
}

function parseFramed(s: string, prefix: string, parts: number): string[] {
  if (typeof s !== 'string') throw new Error('Invalid ciphertext: not a string');
  const p = s.split('.');
  if (p[0] !== prefix) throw new Error(`Invalid ciphertext: expected "${prefix}." prefix`);
  if (p.length !== parts + 1 || p.slice(1).some((x) => x.length === 0)) {
    throw new Error(`Invalid ciphertext: malformed "${prefix}" payload`);
  }
  return p.slice(1);
}

// ---------- user key pair ----------

export async function generateUserKeyPair(): Promise<{
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}> {
  const s = subtle();
  const kp = (await s.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt'])) as CryptoKeyPair;
  const publicJwk = await s.exportKey('jwk', kp.publicKey);
  return { publicJwk, privateKey: kp.privateKey };
}

export async function wrapPrivateKey(privateKey: CryptoKey, kek: CryptoKey): Promise<string> {
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', privateKey));
  const [iv, ct] = await aesEncrypt(kek, pkcs8);
  pkcs8.fill(0);
  return `w1.${iv}.${ct}`;
}

export async function unwrapPrivateKey(
  wrapped: string,
  kek: CryptoKey,
  extractable = false,
): Promise<CryptoKey> {
  const [iv, ct] = parseFramed(wrapped, 'w1', 2);
  const pkcs8 = await aesDecrypt(kek, iv, ct);
  try {
    return await subtle().importKey('pkcs8', buf(pkcs8), RSA_IMPORT, extractable, ['decrypt']);
  } finally {
    pkcs8.fill(0);
  }
}

export function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, RSA_IMPORT, true, ['encrypt']);
}

// ---------- sealed boxes (hybrid RSA-OAEP + AES-256-GCM) ----------

export async function sealTo(
  publicKey: CryptoKey | JsonWebKey,
  plaintext: Uint8Array,
): Promise<string> {
  const s = subtle();
  // A JWK always carries "kty"; a CryptoKey never does (works without a global CryptoKey).
  const pub =
    'kty' in publicKey
      ? await importPublicKey(publicKey as JsonWebKey)
      : (publicKey as CryptoKey);
  const raw = randomBytes(32);
  const aes = await s.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt']);
  const encKey = new Uint8Array(await s.encrypt({ name: 'RSA-OAEP' }, pub, buf(raw)));
  raw.fill(0);
  const [iv, ct] = await aesEncrypt(aes, plaintext);
  return `s1.${toB64(encKey)}.${iv}.${ct}`;
}

export async function openSealed(privateKey: CryptoKey, sealed: string): Promise<Uint8Array> {
  const [encKey, iv, ct] = parseFramed(sealed, 's1', 3);
  const s = subtle();
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await s.decrypt({ name: 'RSA-OAEP' }, privateKey, buf(fromB64(encKey))));
  } catch {
    throw new Error('Decryption failed (wrong key or tampered data)');
  }
  if (raw.length !== 32) throw new Error('Invalid sealed key length');
  const aes = await s.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['decrypt']);
  raw.fill(0);
  return aesDecrypt(aes, iv, ct);
}

// ---------- symmetric (wishlists) ----------

export function generateSymmetricKeyB64(): string {
  return toB64(randomBytes(32));
}

async function importSymmetric(keyB64: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error('Invalid symmetric key: expected 32 bytes');
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptWithKey(keyB64: string, plaintext: Uint8Array): Promise<string> {
  const [iv, ct] = await aesEncrypt(await importSymmetric(keyB64, 'encrypt'), plaintext);
  return `a1.${iv}.${ct}`;
}

export async function decryptWithKey(keyB64: string, ciphertext: string): Promise<Uint8Array> {
  const [iv, ct] = parseFramed(ciphertext, 'a1', 2);
  return aesDecrypt(await importSymmetric(keyB64, 'decrypt'), iv, ct);
}
