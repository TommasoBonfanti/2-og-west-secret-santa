/**
 * In-browser fake backend for previewing the whole app without Supabase.
 *
 * The "server" is a JSON document in localStorage (prefix 'santa-demo:'),
 * but all the crypto is the real thing (@shared/crypto.ts) and the draw uses
 * the real algorithm (@shared/draw.ts), so flows behave like production:
 * passwords are never stored, private keys are stored only wrapped, and
 * assignments / wishlists are sealed and encrypted.
 */
import type { Backend } from './backend';
import { BackendError } from './backend';
import type {
  Assignment,
  EventInfo,
  EventPatch,
  GroupPhoto,
  Participant,
  Preferences,
  Session,
  Wishlist,
} from '../types';
import { MAX_NAME_LENGTH, MAX_WISHLIST_IMAGES, MIN_PASSWORD_LENGTH } from '../types';
import {
  KDF_ITERATIONS,
  decodeJson,
  decryptWithKey,
  deriveFromPassword,
  deriveFromRecoveryCode,
  encodeJson,
  encryptWithKey,
  generateRecoveryCode,
  generateSymmetricKeyB64,
  generateUserKeyPair,
  openSealed,
  pad,
  randomSaltB64,
  sealTo,
  sha256Hex,
  unpad,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '@shared/crypto.ts';
import { DrawImpossibleError, MIN_PARTICIPANTS, drawAssignment, hasValidAssignment } from '@shared/draw.ts';

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

const PREFIX = 'santa-demo:';
const DB_KEY = PREFIX + 'db';
const PHOTOS_KEY = PREFIX + 'photos';
const SESSION_KEY = PREFIX + 'session'; // sessionStorage: current participant id
const REMEMBER_KEY = PREFIX + 'remember'; // localStorage: remembered participant id
const IDB_NAME = 'santa-demo-keys';

interface DemoParticipant {
  id: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
  claimed: boolean;
  kdfSalt: string | null;
  /** Seeded demo accounts use fewer iterations so seeding is quicker. */
  kdfIterations: number | null;
  recoverySalt: string | null;
  publicKey: JsonWebKey | null;
  /** sha256(authSecret) — stands in for Supabase Auth's password hash. */
  authHash: string | null;
}

interface DemoUserKeys {
  wrappedPrivateKey: string;
  recoveryWrappedPrivateKey: string;
  recoveryAuthHash: string;
}

interface DemoDB {
  event: Omit<EventInfo, 'bootstrapped'>;
  participants: DemoParticipant[];
  userKeys: Record<string, DemoUserKeys>;
  preferences: Record<string, Preferences>;
  assignments: Record<string, string>;
  wishlistKeys: Record<string, string>;
  wishlists: Record<string, { ciphertext: string; updatedAt: string }>;
}

interface DemoPhoto {
  id: string;
  dataUrl: string;
}

function freshDb(): DemoDB {
  return {
    event: {
      name: '2 OG WEST Secret Santa 2026',
      budgetAmount: 10,
      currency: 'CHF',
      exchangeDate: null,
      status: 'open',
      drawnAt: null,
    },
    participants: [],
    userKeys: {},
    preferences: {},
    assignments: {},
    wishlistKeys: {},
    wishlists: {},
  };
}

function load(): DemoDB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...freshDb(), ...(JSON.parse(raw) as DemoDB) };
  } catch {
    /* corrupted or unavailable: start over */
  }
  return freshDb();
}

function save(db: DemoDB): void {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    throw new BackendError('The demo storage is full. Try wiping the demo data.');
  }
}

function loadPhotos(): DemoPhoto[] {
  try {
    const raw = localStorage.getItem(PHOTOS_KEY);
    return raw ? (JSON.parse(raw) as DemoPhoto[]) : [];
  } catch {
    return [];
  }
}

function savePhotos(photos: DemoPhoto[]): void {
  try {
    localStorage.setItem(PHOTOS_KEY, JSON.stringify(photos));
  } catch {
    throw new BackendError('No room left for more demo photos (browser storage is full).');
  }
}

const delay = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

function uuid(): string {
  return crypto.randomUUID();
}

function toPublic(p: DemoParticipant): Participant {
  return { id: p.id, name: p.name, isAdmin: p.isAdmin, claimed: p.claimed };
}

// ---------------------------------------------------------------------------
// Remembered keys (non-extractable CryptoKey in IndexedDB)
// ---------------------------------------------------------------------------

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await idbOpen();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  } catch {
    return undefined; // IndexedDB unavailable (private mode etc.): just don't remember
  }
}

const rememberKey = (id: string, key: CryptoKey) => idbRun('readwrite', (s) => s.put(key, id));
const recallKey = (id: string) => idbRun<CryptoKey>('readonly', (s) => s.get(id));
const forgetKeys = () => idbRun('readwrite', (s) => s.clear());

// ---------------------------------------------------------------------------
// Session state (module level so demo tools can reach it)
// ---------------------------------------------------------------------------

let currentId: string | null = null;
let privateKey: CryptoKey | null = null;

function storedSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

async function startSession(p: DemoParticipant, key: CryptoKey, remember: boolean): Promise<Session> {
  currentId = p.id;
  privateKey = key;
  try {
    sessionStorage.setItem(SESSION_KEY, p.id);
    if (remember) {
      localStorage.setItem(REMEMBER_KEY, p.id);
      await rememberKey(p.id, key);
    } else if (localStorage.getItem(REMEMBER_KEY) === p.id) {
      localStorage.removeItem(REMEMBER_KEY);
      await forgetKeys();
    }
  } catch {
    /* storage unavailable: session lives in memory only */
  }
  return { participant: toPublic(p) };
}

async function endSession(): Promise<void> {
  currentId = null;
  privateKey = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* ignore */
  }
  await forgetKeys();
}

/** Current logged-in participant with an unlocked key, or throws. */
function requireMe(db: DemoDB): { me: DemoParticipant; key: CryptoKey } {
  const me = db.participants.find((p) => p.id === currentId);
  if (!me || !privateKey) throw new BackendError('Please log in first.', 'not_logged_in');
  return { me, key: privateKey };
}

function requireAdmin(db: DemoDB): DemoParticipant {
  const { me } = requireMe(db);
  if (!me.isAdmin) throw new BackendError('Only the admin can do that.', 'forbidden');
  return me;
}

function findParticipant(db: DemoDB, id: string): DemoParticipant {
  const p = db.participants.find((x) => x.id === id);
  if (!p) throw new BackendError('That person is no longer on the list.', 'not_found');
  return p;
}

function cleanName(db: DemoDB, raw: string, exceptId?: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw new BackendError('Please enter a name.');
  if (name.length > MAX_NAME_LENGTH) throw new BackendError(`Names can be at most ${MAX_NAME_LENGTH} characters.`);
  if (db.participants.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new BackendError(`"${name}" is already on the list.`);
  }
  return name;
}

function checkPassword(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new BackendError(`Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

/** Sets up keys for a participant. Used by claim() and by demoSeed(). */
async function claimInternal(
  db: DemoDB,
  p: DemoParticipant,
  password: string,
  iterations: number = KDF_ITERATIONS,
): Promise<{ key: CryptoKey; recoveryCode: string }> {
  const kdfSalt = randomSaltB64();
  const recoverySalt = randomSaltB64();
  const { authSecret, kek } = await deriveFromPassword(password, kdfSalt, iterations);
  const recoveryCode = generateRecoveryCode();
  const rec = await deriveFromRecoveryCode(recoveryCode, recoverySalt);
  const pair = await generateUserKeyPair();
  const wrapped = await wrapPrivateKey(pair.privateKey, kek);
  const recoveryWrapped = await wrapPrivateKey(pair.privateKey, rec.kek);

  p.claimed = true;
  p.kdfSalt = kdfSalt;
  p.kdfIterations = iterations;
  p.recoverySalt = recoverySalt;
  p.publicKey = pair.publicJwk;
  p.authHash = await sha256Hex(authSecret);
  db.userKeys[p.id] = {
    wrappedPrivateKey: wrapped,
    recoveryWrappedPrivateKey: recoveryWrapped,
    recoveryAuthHash: await sha256Hex(rec.recoveryAuth),
  };
  // Keep a non-extractable copy in memory.
  const key = await unwrapPrivateKey(wrapped, kek, false);
  return { key, recoveryCode };
}

/** Verifies a password and returns the KEK. */
async function verifyPassword(p: DemoParticipant, password: string) {
  if (!p.claimed || !p.kdfSalt || !p.authHash) {
    throw new BackendError('This name has not been claimed yet.', 'not_claimed');
  }
  const { authSecret, kek } = await deriveFromPassword(password, p.kdfSalt, p.kdfIterations ?? KDF_ITERATIONS);
  if ((await sha256Hex(authSecret)) !== p.authHash) {
    throw new BackendError('That password is not right. Try again?', 'wrong_password');
  }
  return kek;
}

async function unlockFor(db: DemoDB, p: DemoParticipant, password: string, extractable = false): Promise<CryptoKey> {
  const kek = await verifyPassword(p, password);
  const keys = db.userKeys[p.id];
  if (!keys) throw new BackendError('Your account keys are missing. Ask the admin to reset your account.');
  try {
    return await unwrapPrivateKey(keys.wrappedPrivateKey, kek, extractable);
  } catch {
    throw new BackendError('Could not unlock your keys with that password.', 'wrong_password');
  }
}

async function myWishlistKey(db: DemoDB, id: string, key: CryptoKey): Promise<string | null> {
  const sealed = db.wishlistKeys[id];
  if (!sealed) return null;
  const { wishlistKey } = decodeJson<{ v: number; wishlistKey: string }>(unpad(await openSealed(key, sealed)));
  return wishlistKey;
}

async function decryptWishlist(db: DemoDB, ownerId: string, wishlistKey: string): Promise<Wishlist | null> {
  const row = db.wishlists[ownerId];
  if (!row) return null;
  const data = decodeJson<{ v: number; text: string; links: string[]; images: Wishlist['images'] }>(
    await decryptWithKey(wishlistKey, row.ciphertext),
  );
  return { text: data.text ?? '', links: data.links ?? [], images: data.images ?? [], updatedAt: row.updatedAt };
}

// ---------------------------------------------------------------------------
// Placeholder photos (festive polaroid fillers, no text)
// ---------------------------------------------------------------------------

function svgUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const PLACEHOLDERS: string[] = [
  // Tree
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#2e5d3a"/><circle cx="60" cy="60" r="4" fill="#fff3e0"/><circle cx="240" cy="90" r="3" fill="#fff3e0"/><circle cx="200" cy="40" r="2.5" fill="#fff3e0"/><polygon points="150,50 90,150 120,150 70,220 230,220 180,150 210,150" fill="#7fd18b"/><rect x="138" y="220" width="24" height="34" fill="#6b3a1e"/><polygon points="150,32 156,46 171,46 159,55 164,70 150,61 136,70 141,55 129,46 144,46" fill="#ffd36b"/><circle cx="125" cy="140" r="7" fill="#e02424"/><circle cx="175" cy="180" r="7" fill="#ffd36b"/><circle cx="130" cy="200" r="7" fill="#fff3e0"/><circle cx="160" cy="115" r="6" fill="#e02424"/></svg>`,
  // Presents
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#f3d9b1"/><rect x="50" y="140" width="110" height="100" rx="6" fill="#b31b1b"/><rect x="98" y="140" width="14" height="100" fill="#ffd36b"/><rect x="50" y="182" width="110" height="14" fill="#ffd36b"/><rect x="170" y="170" width="80" height="70" rx="6" fill="#2e7d32"/><rect x="203" y="170" width="12" height="70" fill="#fff3e0"/><ellipse cx="92" cy="132" rx="18" ry="10" fill="#ffd36b"/><ellipse cx="120" cy="132" rx="18" ry="10" fill="#ffd36b"/><ellipse cx="200" cy="164" rx="13" ry="8" fill="#fff3e0"/><ellipse cx="220" cy="164" rx="13" ry="8" fill="#fff3e0"/></svg>`,
  // Candy cane stripes
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><pattern id="s" width="30" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="30" height="30" fill="#fff"/><rect width="15" height="30" fill="#e02424"/></pattern></defs><rect width="300" height="300" fill="#fff6e8"/><path d="M110 250 V120 a40 40 0 0 1 80 0" fill="none" stroke="#5c0d0d" stroke-width="40" stroke-linecap="round"/><path d="M110 250 V120 a40 40 0 0 1 80 0" fill="none" stroke="url(#s)" stroke-width="30" stroke-linecap="round"/></svg>`,
  // Fireplace glow
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#3d1a0a"/><rect x="40" y="90" width="220" height="180" fill="#7a3b1c"/><rect x="80" y="140" width="140" height="130" fill="#1c0b04"/><path d="M150 260 C110 230 120 200 140 180 C140 200 150 205 155 190 C160 175 150 165 160 150 C185 180 195 230 150 260Z" fill="#ffd36b"/><path d="M150 260 C130 245 135 225 148 212 C150 228 162 230 165 220 C175 240 170 252 150 260Z" fill="#e02424"/><rect x="30" y="80" width="240" height="16" fill="#5a2a14"/></svg>`,
  // Snowy window
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#1f3b5c"/><circle cx="60" cy="50" r="5" fill="#fff"/><circle cx="130" cy="90" r="4" fill="#fff"/><circle cx="230" cy="60" r="6" fill="#fff"/><circle cx="190" cy="140" r="4" fill="#fff"/><circle cx="80" cy="160" r="5" fill="#fff"/><path d="M0 230 Q75 200 150 225 T300 215 V300 H0Z" fill="#fffaf0"/><circle cx="210" cy="200" r="26" fill="#fffaf0"/><circle cx="210" cy="160" r="18" fill="#fffaf0"/><polygon points="210,160 230,165 210,168" fill="#ff8a3d"/><rect x="190" y="138" width="40" height="6" fill="#b31b1b"/></svg>`,
  // Mug of cocoa
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#e9c58f"/><rect x="85" y="120" width="110" height="120" rx="14" fill="#b31b1b"/><path d="M195 145 h20 a25 25 0 0 1 0 50 h-20" fill="none" stroke="#b31b1b" stroke-width="14"/><ellipse cx="140" cy="122" rx="55" ry="12" fill="#6b3a1e"/><path d="M120 100 q-10 -20 0 -40 M145 100 q-10 -20 0 -40 M170 100 q-10 -20 0 -40" stroke="#fff3e0" stroke-width="6" fill="none" stroke-linecap="round"/><rect x="85" y="170" width="110" height="12" fill="#fff3e0"/></svg>`,
].map(svgUrl);

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export function createDemoBackend(): Backend {
  return {
    mode: 'demo',

    async getEvent(): Promise<EventInfo> {
      await delay();
      const db = load();
      return { ...db.event, bootstrapped: db.participants.length > 0 };
    },

    async listParticipants(): Promise<Participant[]> {
      await delay();
      return load()
        .participants.slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toPublic);
    },

    async bootstrap(adminName: string): Promise<void> {
      await delay();
      const db = load();
      if (db.participants.length > 0) throw new BackendError('This Secret Santa has already been set up.');
      const name = cleanName(db, adminName);
      db.participants.push({
        id: uuid(),
        name,
        isAdmin: true,
        createdAt: new Date().toISOString(),
        claimed: false,
        kdfSalt: null,
        kdfIterations: null,
        recoverySalt: null,
        publicKey: null,
        authHash: null,
      });
      save(db);
    },

    async claim(participantId, password, remember) {
      await delay();
      checkPassword(password);
      const db = load();
      const p = findParticipant(db, participantId);
      if (p.claimed) throw new BackendError(`${p.name} has already joined. Try logging in instead.`, 'already_claimed');
      const { key, recoveryCode } = await claimInternal(db, p, password);
      save(db);
      const session = await startSession(p, key, remember);
      return { session, recoveryCode };
    },

    async login(participantId, password, remember) {
      await delay();
      const db = load();
      const p = findParticipant(db, participantId);
      const key = await unlockFor(db, p, password);
      return startSession(p, key, remember);
    },

    async restoreSession() {
      await delay();
      const id = storedSessionId();
      if (!id) return null;
      const db = load();
      const p = db.participants.find((x) => x.id === id);
      if (!p || !p.claimed) {
        await endSession();
        return null;
      }
      if (privateKey && currentId === id) return { participant: toPublic(p) };
      currentId = id;
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(REMEMBER_KEY);
      } catch {
        /* ignore */
      }
      if (remembered === id) {
        const key = await recallKey(id);
        if (key) {
          privateKey = key;
          try {
            sessionStorage.setItem(SESSION_KEY, id);
          } catch {
            /* ignore */
          }
          return { participant: toPublic(p) };
        }
      }
      return 'locked';
    },

    async unlock(password, remember) {
      await delay();
      const id = currentId ?? storedSessionId();
      if (!id) throw new BackendError('Your session has expired. Please log in again.', 'not_logged_in');
      const db = load();
      const p = findParticipant(db, id);
      const key = await unlockFor(db, p, password);
      return startSession(p, key, remember);
    },

    async logout() {
      await delay();
      await endSession();
    },

    async changePassword(oldPassword, newPassword) {
      await delay();
      checkPassword(newPassword);
      const db = load();
      const { me } = requireMe(db);
      const extractable = await unlockFor(db, me, oldPassword, true);
      const kdfSalt = randomSaltB64();
      const { authSecret, kek } = await deriveFromPassword(newPassword, kdfSalt);
      db.userKeys[me.id].wrappedPrivateKey = await wrapPrivateKey(extractable, kek);
      me.kdfSalt = kdfSalt;
      me.kdfIterations = KDF_ITERATIONS;
      me.authHash = await sha256Hex(authSecret);
      save(db);
    },

    async recover(participantId, recoveryCode, newPassword) {
      await delay();
      checkPassword(newPassword);
      const db = load();
      const p = findParticipant(db, participantId);
      const keys = db.userKeys[p.id];
      if (!p.claimed || !p.recoverySalt || !keys) throw new BackendError('This name has not been claimed yet.');
      const rec = await deriveFromRecoveryCode(recoveryCode, p.recoverySalt);
      if ((await sha256Hex(rec.recoveryAuth)) !== keys.recoveryAuthHash) {
        throw new BackendError("That recovery code doesn't match. Check it and try again.", 'wrong_recovery');
      }
      const extractable = await unwrapPrivateKey(keys.recoveryWrappedPrivateKey, rec.kek, true);
      const kdfSalt = randomSaltB64();
      const { authSecret, kek } = await deriveFromPassword(newPassword, kdfSalt);
      keys.wrappedPrivateKey = await wrapPrivateKey(extractable, kek);
      p.kdfSalt = kdfSalt;
      p.kdfIterations = KDF_ITERATIONS;
      p.authHash = await sha256Hex(authSecret);
      save(db);
      const key = await unwrapPrivateKey(keys.wrappedPrivateKey, kek, false);
      return startSession(p, key, false);
    },

    async getMyPreferences() {
      await delay();
      const db = load();
      const { me } = requireMe(db);
      return db.preferences[me.id] ?? { noGiveTo: null, noReceiveFrom: null };
    },

    async setMyPreferences(prefs) {
      await delay();
      const db = load();
      const { me } = requireMe(db);
      if (db.event.status !== 'open') throw new BackendError('Wishes are locked once the names are drawn.');
      const ids = new Set(db.participants.map((p) => p.id));
      for (const v of [prefs.noGiveTo, prefs.noReceiveFrom]) {
        if (v === me.id) throw new BackendError("You can't pick yourself here.");
        if (v && !ids.has(v)) throw new BackendError('That person is no longer on the list.');
      }
      db.preferences[me.id] = { noGiveTo: prefs.noGiveTo ?? null, noReceiveFrom: prefs.noReceiveFrom ?? null };
      save(db);
    },

    async getMyAssignment(): Promise<Assignment | null> {
      await delay();
      const db = load();
      const { me, key } = requireMe(db);
      const sealed = db.assignments[me.id];
      if (db.event.status !== 'drawn' || !sealed) return null;
      const { receiverId, wishlistKey } = decodeJson<{ v: number; receiverId: string; wishlistKey: string }>(
        unpad(await openSealed(key, sealed)),
      );
      const receiver = db.participants.find((p) => p.id === receiverId);
      return {
        receiverId,
        receiverName: receiver?.name ?? 'someone who left the list',
        wishlist: await decryptWishlist(db, receiverId, wishlistKey),
      };
    },

    async getMyWishlist() {
      await delay();
      const db = load();
      const { me, key } = requireMe(db);
      const wk = await myWishlistKey(db, me.id, key);
      return wk ? decryptWishlist(db, me.id, wk) : null;
    },

    async saveMyWishlist(wishlist) {
      await delay();
      const db = load();
      const { me, key } = requireMe(db);
      if (db.event.status !== 'drawn') throw new BackendError('Wishlists open once the names are drawn.');
      const wk = await myWishlistKey(db, me.id, key);
      if (!wk) throw new BackendError("Your wishlist key is missing. Ask the admin — the draw may need a redo.");
      if (wishlist.images.length > MAX_WISHLIST_IMAGES) {
        throw new BackendError(`You can add up to ${MAX_WISHLIST_IMAGES} pictures.`);
      }
      for (const l of wishlist.links) {
        if (!/^https?:\/\//i.test(l)) throw new BackendError(`"${l}" doesn't look like a web link.`);
      }
      const payload = { v: 1, text: wishlist.text, links: wishlist.links, images: wishlist.images };
      db.wishlists[me.id] = {
        ciphertext: await encryptWithKey(wk, encodeJson(payload)),
        updatedAt: new Date().toISOString(),
      };
      save(db);
    },

    async listGroupPhotos(): Promise<GroupPhoto[]> {
      await delay();
      const photos = loadPhotos();
      if (photos.length === 0) return PLACEHOLDERS.map((url, i) => ({ id: `placeholder-${i + 1}`, url }));
      return photos.map((p) => ({ id: p.id, url: p.dataUrl }));
    },

    // ----- Admin -----

    async updateEvent(patch: EventPatch) {
      await delay();
      const db = load();
      requireAdmin(db);
      if (patch.name !== undefined) {
        const n = patch.name.trim();
        if (!n) throw new BackendError('The event needs a name.');
        db.event.name = n.slice(0, 80);
      }
      if (patch.budgetAmount !== undefined) {
        if (!Number.isFinite(patch.budgetAmount) || patch.budgetAmount < 0) {
          throw new BackendError('The budget must be a positive number.');
        }
        db.event.budgetAmount = patch.budgetAmount;
      }
      if (patch.currency !== undefined) db.event.currency = patch.currency.trim().toUpperCase().slice(0, 8) || 'CHF';
      if (patch.exchangeDate !== undefined) db.event.exchangeDate = patch.exchangeDate || null;
      save(db);
    },

    async addParticipant(name) {
      await delay();
      const db = load();
      requireAdmin(db);
      if (db.event.status !== 'open') throw new BackendError("You can't add people after the draw. Reset the draw first.");
      db.participants.push({
        id: uuid(),
        name: cleanName(db, name),
        isAdmin: false,
        createdAt: new Date().toISOString(),
        claimed: false,
        kdfSalt: null,
        kdfIterations: null,
        recoverySalt: null,
        publicKey: null,
        authHash: null,
      });
      save(db);
    },

    async renameParticipant(id, name) {
      await delay();
      const db = load();
      requireAdmin(db);
      if (db.event.status !== 'open') throw new BackendError("Names can't change after the draw.");
      const p = findParticipant(db, id);
      p.name = cleanName(db, name, id);
      save(db);
    },

    async removeParticipant(id) {
      await delay();
      const db = load();
      requireAdmin(db);
      if (db.event.status !== 'open') throw new BackendError("You can't remove people after the draw.");
      const p = findParticipant(db, id);
      if (p.claimed) throw new BackendError(`${p.name} has already joined, so they can't be removed.`);
      db.participants = db.participants.filter((x) => x.id !== id);
      // Drop preferences that pointed at them.
      for (const pref of Object.values(db.preferences)) {
        if (pref.noGiveTo === id) pref.noGiveTo = null;
        if (pref.noReceiveFrom === id) pref.noReceiveFrom = null;
      }
      save(db);
    },

    async resetParticipant(id) {
      await delay();
      const db = load();
      const admin = requireAdmin(db);
      if (id === admin.id) throw new BackendError("You can't reset your own account from here.");
      const p = findParticipant(db, id);
      p.claimed = false;
      p.kdfSalt = null;
      p.kdfIterations = null;
      p.recoverySalt = null;
      p.publicKey = null;
      p.authHash = null;
      delete db.userKeys[id];
      delete db.preferences[id];
      save(db);
      return { needsRedraw: db.event.status === 'drawn' };
    },

    async draw() {
      await delay(400);
      const db = load();
      requireAdmin(db);
      if (db.event.status !== 'open') throw new BackendError('The names have already been drawn.');
      if (db.participants.length < MIN_PARTICIPANTS) {
        throw new BackendError(`You need at least ${MIN_PARTICIPANTS} people for a draw.`);
      }
      const missing = db.participants.filter((p) => !p.claimed || !p.publicKey);
      if (missing.length) {
        throw new BackendError(`Still waiting for: ${missing.map((p) => p.name).join(', ')}.`);
      }
      const ids = db.participants.map((p) => p.id);
      const noGiveTo: Record<string, string | null> = {};
      const noReceiveFrom: Record<string, string | null> = {};
      for (const id of ids) {
        noGiveTo[id] = db.preferences[id]?.noGiveTo ?? null;
        noReceiveFrom[id] = db.preferences[id]?.noReceiveFrom ?? null;
      }
      let pairs: Map<string, string>;
      try {
        pairs = drawAssignment({ ids, noGiveTo, noReceiveFrom });
      } catch (e) {
        if (e instanceof DrawImpossibleError) {
          throw new BackendError(
            "The draw isn't possible with everyone's current wishes. Ask people to relax a preference and try again.",
            'draw_impossible',
          );
        }
        throw e;
      }
      const wishlistKeys = new Map(ids.map((id) => [id, generateSymmetricKeyB64()]));
      const byId = new Map(db.participants.map((p) => [p.id, p]));
      const assignments: Record<string, string> = {};
      const sealedKeys: Record<string, string> = {};
      for (const [giver, receiver] of pairs) {
        assignments[giver] = await sealTo(
          byId.get(giver)!.publicKey!,
          pad(encodeJson({ v: 1, receiverId: receiver, wishlistKey: wishlistKeys.get(receiver) }), 256),
        );
      }
      for (const [id, wk] of wishlistKeys) {
        sealedKeys[id] = await sealTo(byId.get(id)!.publicKey!, pad(encodeJson({ v: 1, wishlistKey: wk }), 256));
      }
      db.assignments = assignments;
      db.wishlistKeys = sealedKeys;
      db.wishlists = {};
      db.event.status = 'drawn';
      db.event.drawnAt = new Date().toISOString();
      save(db);
    },

    async resetDraw() {
      await delay();
      const db = load();
      requireAdmin(db);
      db.assignments = {};
      db.wishlistKeys = {};
      db.wishlists = {};
      db.event.status = 'open';
      db.event.drawnAt = null;
      save(db);
    },

    async uploadGroupPhoto(file: Blob) {
      await delay();
      const db = load();
      requireAdmin(db);
      if (!file.type.startsWith('image/')) throw new BackendError('Only pictures can be uploaded.');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new BackendError('Could not read that picture.'));
        r.readAsDataURL(file);
      });
      const photos = loadPhotos();
      photos.push({ id: uuid(), dataUrl });
      savePhotos(photos);
    },

    async deleteGroupPhoto(id) {
      await delay();
      const db = load();
      requireAdmin(db);
      savePhotos(loadPhotos().filter((p) => p.id !== id));
    },
  };
}

// ---------------------------------------------------------------------------
// Demo tools (not part of the Backend interface)
// ---------------------------------------------------------------------------

export const DEMO_PASSWORD = 'demo-password-123';
const SEED_NAMES = ['Marco', 'Giulia', 'Luca', 'Sofia', 'Matteo', 'Chiara', 'Davide', 'Elena', 'Andrea', 'Sara', 'Pietro'];

/**
 * Adds example flatmates and claims everyone except the current user with
 * DEMO_PASSWORD (so you can log in as them). Key generation is slow, so it
 * runs sequentially and reports progress. Also sets a few random wishes.
 */
export async function demoSeed(onProgress?: (done: number, total: number, name: string) => void): Promise<void> {
  let db = load();
  if (db.participants.length === 0) throw new BackendError('Set up the event first (enter your name), then seed.');
  if (db.event.status !== 'open') throw new BackendError('Reset the draw first, then seed.');

  for (const name of SEED_NAMES) {
    if (!db.participants.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      db.participants.push({
        id: uuid(),
        name,
        isAdmin: false,
        createdAt: new Date().toISOString(),
        claimed: false,
        kdfSalt: null,
        kdfIterations: null,
        recoverySalt: null,
        publicKey: null,
        authHash: null,
      });
    }
  }
  save(db);

  const todo = db.participants.filter((p) => !p.claimed && p.id !== currentId);
  let done = 0;
  onProgress?.(done, todo.length, todo[0]?.name ?? '');
  for (const target of todo) {
    onProgress?.(done, todo.length, target.name);
    db = load(); // re-read so concurrent UI changes aren't lost
    const p = db.participants.find((x) => x.id === target.id);
    if (p && !p.claimed) {
      // Fewer PBKDF2 iterations for seeded accounts keeps seeding bearable.
      await claimInternal(db, p, DEMO_PASSWORD, 50_000);
      save(db);
    }
    done++;
    onProgress?.(done, todo.length, target.name);
  }

  // A few random, still-drawable preferences for the seeded people.
  db = load();
  const ids = db.participants.map((p) => p.id);
  const seeded = db.participants.filter((p) => p.id !== currentId && SEED_NAMES.includes(p.name));
  const pick = (exclude: string) => {
    const others = ids.filter((x) => x !== exclude);
    return others[Math.floor(Math.random() * others.length)] ?? null;
  };
  for (const p of seeded.slice(0, 4)) {
    const prefs: Preferences = {
      noGiveTo: Math.random() < 0.7 ? pick(p.id) : null,
      noReceiveFrom: Math.random() < 0.4 ? pick(p.id) : null,
    };
    const trial = { ...db.preferences, [p.id]: prefs };
    const input = {
      ids,
      noGiveTo: Object.fromEntries(ids.map((id) => [id, trial[id]?.noGiveTo ?? null])),
      noReceiveFrom: Object.fromEntries(ids.map((id) => [id, trial[id]?.noReceiveFrom ?? null])),
    };
    if (ids.length < 3 || hasValidAssignment(input)) db.preferences = trial;
  }
  save(db);
}

/** Removes every trace of the demo (data, photos, session, remembered keys). */
export async function demoWipe(): Promise<void> {
  currentId = null;
  privateKey = null;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  try {
    indexedDB.deleteDatabase(IDB_NAME);
  } catch {
    /* ignore */
  }
}

