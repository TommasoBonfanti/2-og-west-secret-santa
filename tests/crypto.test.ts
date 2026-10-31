import { beforeAll, describe, expect, it } from 'vitest';
import {
  KDF_ITERATIONS,
  RECOVERY_KDF_ITERATIONS,
  decodeJson,
  decryptWithKey,
  deriveFromPassword,
  deriveFromRecoveryCode,
  encodeJson,
  encryptWithKey,
  fromB64,
  generateRecoveryCode,
  generateSymmetricKeyB64,
  generateUserKeyPair,
  importPublicKey,
  normalizeRecoveryCode,
  openSealed,
  pad,
  randomBytes,
  randomSaltB64,
  sealTo,
  sha256Hex,
  toB64,
  unpad,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '../supabase/functions/_shared/crypto.ts';

const FAST = 1000;

// Flip one bit inside the base64 segment at `index` of a dotted ciphertext.
function tamper(s: string, index: number): string {
  const parts = s.split('.');
  const bytes = fromB64(parts[index]);
  bytes[bytes.length >> 1] ^= 1;
  parts[index] = toB64(bytes);
  return parts.join('.');
}

// Fast equality for large arrays (toEqual is slow on 300 KB).
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type KP = Awaited<ReturnType<typeof generateUserKeyPair>>;
let alice: KP;
let bob: KP;

beforeAll(async () => {
  [alice, bob] = await Promise.all([generateUserKeyPair(), generateUserKeyPair()]);
}, 120_000);

describe('constants', () => {
  it('match the contract', () => {
    expect(KDF_ITERATIONS).toBe(600_000);
    expect(RECOVERY_KDF_ITERATIONS).toBe(100_000);
  });
});

describe('base64', () => {
  it('round-trips small and empty arrays', () => {
    for (const n of [0, 1, 2, 3, 31, 255]) {
      const b = randomBytes(n);
      expect(fromB64(toB64(b))).toEqual(b);
    }
    expect(toB64(new Uint8Array([251, 255]))).toBe('+/8=');
  });

  it('round-trips 300 KB without stack overflow', () => {
    const b = randomBytes(300 * 1024);
    expect(sameBytes(fromB64(toB64(b)), b)).toBe(true);
  });

  it('rejects invalid base64', () => {
    expect(() => fromB64('!!!not base64')).toThrow();
  });

  it('randomSaltB64 is 16 bytes', () => {
    expect(fromB64(randomSaltB64())).toHaveLength(16);
  });
});

describe('json', () => {
  it('round-trips', () => {
    const v = { v: 1, text: 'ciao ðŸŽ…', n: [1, 2] };
    expect(decodeJson<typeof v>(encodeJson(v))).toEqual(v);
  });
});

describe('pad/unpad', () => {
  it('round-trips with exact size', () => {
    for (const n of [0, 1, 100, 252]) {
      const b = randomBytes(n);
      const p = pad(b, 256);
      expect(p).toHaveLength(256);
      expect(unpad(p)).toEqual(b);
    }
  });

  it('throws when too large', () => {
    expect(() => pad(new Uint8Array(253), 256)).toThrow();
  });

  it('rejects corrupted padding', () => {
    const p = pad(new Uint8Array([1, 2, 3]), 32);
    const badLen = p.slice();
    badLen[3] = 200;
    expect(() => unpad(badLen)).toThrow();
    const badFill = p.slice();
    badFill[31] = 1;
    expect(() => unpad(badFill)).toThrow();
    expect(() => unpad(new Uint8Array(2))).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('deriveFromPassword', () => {
  it('is deterministic and authSecret is 64 lowercase hex chars', async () => {
    const salt = randomSaltB64();
    const a = await deriveFromPassword('correct horse battery', salt, FAST);
    const b = await deriveFromPassword('correct horse battery', salt, FAST);
    expect(a.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.authSecret).toBe(b.authSecret);
    expect(a.kek.extractable).toBe(false);
    expect(a.kek.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('differs with a different salt or password', async () => {
    const a = await deriveFromPassword('pw-1234567', randomSaltB64(), FAST);
    const b = await deriveFromPassword('pw-1234567', randomSaltB64(), FAST);
    const salt = randomSaltB64();
    const c = await deriveFromPassword('pw-1234567', salt, FAST);
    const d = await deriveFromPassword('pw-7654321', salt, FAST);
    expect(a.authSecret).not.toBe(b.authSecret);
    expect(c.authSecret).not.toBe(d.authSecret);
  });

  it('KEK from same inputs decrypts what the other encrypted', async () => {
    const salt = randomSaltB64();
    const a = await deriveFromPassword('pw', salt, FAST);
    const b = await deriveFromPassword('pw', salt, FAST);
    const w = await wrapPrivateKey(alice.privateKey, a.kek);
    await expect(unwrapPrivateKey(w, b.kek)).resolves.toBeDefined();
  });
});

describe('wrap/unwrap private key', () => {
  it('round-trips with the right KEK and fails with a wrong password', async () => {
    const salt = randomSaltB64();
    const { kek } = await deriveFromPassword('right password', salt, FAST);
    const wrapped = await wrapPrivateKey(alice.privateKey, kek);
    expect(wrapped).toMatch(/^w1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);

    const key = await unwrapPrivateKey(wrapped, kek);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['decrypt']);
    const sealed = await sealTo(alice.publicJwk, new Uint8Array([9, 8, 7]));
    expect(await openSealed(key, sealed)).toEqual(new Uint8Array([9, 8, 7]));

    const extractable = await unwrapPrivateKey(wrapped, kek, true);
    expect(extractable.extractable).toBe(true);

    const wrong = await deriveFromPassword('wrong password', salt, FAST);
    await expect(unwrapPrivateKey(wrapped, wrong.kek)).rejects.toThrow();
  });

  it('rejects malformed input', async () => {
    const { kek } = await deriveFromPassword('x', randomSaltB64(), FAST);
    await expect(unwrapPrivateKey('w2.AAAA.AAAA', kek)).rejects.toThrow(/prefix/);
    await expect(unwrapPrivateKey('w1.AAAA', kek)).rejects.toThrow(/malformed/);
    await expect(unwrapPrivateKey('garbage', kek)).rejects.toThrow();
  });
});

describe('recovery code', () => {
  it('has the expected format and â‰¥128 bits of entropy', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{1,4})+$/);
    const chars = code.replace(/-/g, '');
    expect(chars.length * 5).toBeGreaterThanOrEqual(128);
  });

  it('is unique across many draws', () => {
    const set = new Set(Array.from({ length: 500 }, generateRecoveryCode));
    expect(set.size).toBe(500);
  });

  it('normalizes case, separators, whitespace and confusable letters', () => {
    expect(normalizeRecoveryCode(' abcd-efgh \n 1234 ')).toBe('ABCDEFGH1234');
    expect(normalizeRecoveryCode('oOiIlL')).toBe('001111');
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''));
  });

  it('derives deterministically regardless of formatting', async () => {
    const salt = randomSaltB64();
    const a = await deriveFromRecoveryCode('0000-1111-ABCD', salt);
    const b = await deriveFromRecoveryCode('oooo iiil abcd', salt);
    expect(a.recoveryAuth).toMatch(/^[0-9a-f]{64}$/);
    expect(a.recoveryAuth).toBe(b.recoveryAuth);
    const w = await wrapPrivateKey(bob.privateKey, a.kek);
    await expect(unwrapPrivateKey(w, b.kek)).resolves.toBeDefined();

    const other = await deriveFromRecoveryCode('0000-1111-ABCE', salt);
    expect(other.recoveryAuth).not.toBe(a.recoveryAuth);
    await expect(unwrapPrivateKey(w, other.kek)).rejects.toThrow();
  });
});

describe('sealed boxes', () => {
  it('round-trips with a CryptoKey and with a JWK', async () => {
    const msg = encodeJson({ v: 1, receiverId: 'abc', wishlistKey: generateSymmetricKeyB64() });
    const pub = await importPublicKey(alice.publicJwk);
    const s1 = await sealTo(pub, msg);
    const s2 = await sealTo(alice.publicJwk, msg);
    expect(s1).toMatch(/^s1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(s1).not.toBe(s2);
    expect(await openSealed(alice.privateKey, s1)).toEqual(msg);
    expect(await openSealed(alice.privateKey, s2)).toEqual(msg);
  });

  it("fails to open with another person's key", async () => {
    const s = await sealTo(alice.publicJwk, new Uint8Array([1, 2, 3]));
    await expect(openSealed(bob.privateKey, s)).rejects.toThrow();
  });

  it('fails on tampered ciphertext or encrypted key', async () => {
    const s = await sealTo(alice.publicJwk, randomBytes(64));
    await expect(openSealed(alice.privateKey, tamper(s, 3))).rejects.toThrow();
    await expect(openSealed(alice.privateKey, tamper(s, 1))).rejects.toThrow();
    await expect(openSealed(alice.privateKey, tamper(s, 2))).rejects.toThrow();
  });

  it('rejects unknown prefix / malformed input', async () => {
    await expect(openSealed(alice.privateKey, 'x1.a.b.c')).rejects.toThrow(/prefix/);
    await expect(openSealed(alice.privateKey, 's1.a.b')).rejects.toThrow(/malformed/);
  });

  it('padded 256-byte payloads produce constant-size output', async () => {
    const sizes = new Set<number>();
    for (const p of [{ v: 1, wishlistKey: generateSymmetricKeyB64() }, {
      v: 1,
      receiverId: '00000000-0000-0000-0000-000000000000',
      wishlistKey: generateSymmetricKeyB64(),
    }, {}]) {
      const s = await sealTo(bob.publicJwk, pad(encodeJson(p), 256));
      sizes.add(s.length);
      expect(decodeJson(unpad(await openSealed(bob.privateKey, s)))).toEqual(p);
    }
    expect(sizes.size).toBe(1);
  });
});

describe('symmetric encryption', () => {
  it('round-trips and rejects tampering / wrong key', async () => {
    const key = generateSymmetricKeyB64();
    expect(fromB64(key)).toHaveLength(32);
    const pt = randomBytes(300 * 1024);
    const ct = await encryptWithKey(key, pt);
    expect(ct).toMatch(/^a1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(sameBytes(await decryptWithKey(key, ct), pt)).toBe(true);

    await expect(decryptWithKey(key, tamper(ct, 2))).rejects.toThrow();
    await expect(decryptWithKey(key, tamper(ct, 1))).rejects.toThrow();
    await expect(decryptWithKey(generateSymmetricKeyB64(), ct)).rejects.toThrow();
    await expect(decryptWithKey(key, 'b1.' + ct.slice(3))).rejects.toThrow(/prefix/);
    await expect(decryptWithKey('AAAA', ct)).rejects.toThrow(/32 bytes/);
  });
});
