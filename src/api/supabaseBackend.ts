// Real backend: Supabase (Postgres + Auth + Storage + Edge Function "santa").
//
// Security notes (see docs/SECURITY.md):
// - The user's password never leaves this file: Supabase only receives
//   `authSecret` (PBKDF2-derived); the KEK derived alongside it unwraps the
//   RSA private key locally.
// - The unlocked private key lives only in the closure below (and, if the user
//   asks to be remembered, as a NON-extractable CryptoKey in IndexedDB).
// - Wishlists: always fetch ALL rows and decrypt only the one we hold a key
//   for, so request logs never reveal whose wishlist someone reads.

import { createClient, FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import {
  decodeJson,
  decryptWithKey,
  deriveFromPassword,
  deriveFromRecoveryCode,
  encodeJson,
  encryptWithKey,
  generateRecoveryCode,
  generateUserKeyPair,
  openSealed,
  randomSaltB64,
  sha256Hex,
  unpad,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '@shared/crypto.ts';
import { BackendError, type Backend } from './backend';
import {
  MAX_NAME_LENGTH,
  MAX_WISHLIST_IMAGES,
  MIN_PASSWORD_LENGTH,
  type Assignment,
  type EventInfo,
  type EventPatch,
  type GroupPhoto,
  type Participant,
  type Preferences,
  type Session,
  type Wishlist,
  type WishlistImage,
} from '../types';

const FUNCTION_NAME = 'santa';
const PHOTO_BUCKET = 'group-photos';
const SIGNED_URL_SECONDS = 60 * 60;
const IDB_NAME = 'santa-keys';
const IDB_STORE = 'keys';

const emailFor = (participantId: string) => `p-${participantId}@example.com`;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ParticipantRow {
  id: string;
  name: string;
  is_admin: boolean;
  user_id: string | null;
  kdf_salt: string | null;
  recovery_salt: string | null;
}

interface EventRow {
  name: string;
  budget_amount: number | string;
  currency: string;
  exchange_date: string | null;
  status: 'open' | 'drawn';
  drawn_at: string | null;
}

interface WishlistRow {
  participant_id: string;
  ciphertext: string;
  updated_at: string | null;
}

interface WishlistPayload {
  v: number;
  text?: unknown;
  links?: unknown;
  images?: unknown;
}

const PARTICIPANT_COLUMNS = 'id, name, is_admin, user_id, kdf_salt, recovery_salt';

function toParticipant(r: ParticipantRow): Participant {
  return { id: r.id, name: r.name, isAdmin: r.is_admin === true, claimed: r.user_id != null };
}

// ---------------------------------------------------------------------------
// Remembered keys (non-extractable CryptoKey in IndexedDB)
// ---------------------------------------------------------------------------

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    if (typeof indexedDB === 'undefined') return undefined;
    const db = await idbOpen();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const req = fn(tx.objectStore(IDB_STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined; // IndexedDB unavailable (private mode etc.): just don't remember
  }
}

const rememberKey = (participantId: string, key: CryptoKey) => idbRun('readwrite', (s) => s.put(key, participantId));
const recallKey = (participantId: string) => idbRun<CryptoKey>('readonly', (s) => s.get(participantId));
const forgetKey = (participantId: string) => idbRun('readwrite', (s) => s.delete(participantId));
const forgetAllKeys = () => idbRun('readwrite', (s) => s.clear());

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

interface DbError {
  message?: string;
  code?: string;
}

/** Messages raised by our SQL functions are user-facing; technical errors get a friendly fallback. */
function dbError(err: DbError | null | undefined, fallback: string): BackendError {
  const code = err?.code ?? '';
  const msg = err?.message ?? '';
  if (code === 'PGRST301' || /jwt expired/i.test(msg)) {
    return new BackendError('Your session has expired. Please log in again.', 'not_logged_in');
  }
  if (code === 'PGRST202' || code === '42883' || code === '42P01') {
    return new BackendError('The database is not set up yet. The admin needs to run the SQL migration.', 'not_setup');
  }
  // Errors raised by our own functions (P0001 default, plus the explicit codes we use).
  if (['P0001', 'P0002', '42501', '22023', '23505'].includes(code) && msg) {
    return new BackendError(msg, code);
  }
  if (/failed to fetch|network|load failed/i.test(msg)) {
    return new BackendError('Could not reach the server. Check your connection and try again.', 'network');
  }
  return new BackendError(fallback);
}

async function functionError(error: unknown, fallback: string): Promise<BackendError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await (error.context as Response).json()) as { error?: unknown };
      if (body && typeof body.error === 'string' && body.error) return new BackendError(body.error);
    } catch {
      /* not JSON */
    }
    return new BackendError(fallback);
  }
  return new BackendError('Could not reach the server. Check your connection and try again.', 'network');
}

function checkPassword(pw: string): void {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw new BackendError(`Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 'weak_password');
  }
}

function cleanName(name: string): string {
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new BackendError('Please enter a name.');
  if (n.length > MAX_NAME_LENGTH) throw new BackendError(`Names can be at most ${MAX_NAME_LENGTH} characters.`);
  return n;
}

function parseWishlist(bytes: Uint8Array, updatedAt: string | null): Wishlist {
  const p = decodeJson<WishlistPayload>(bytes);
  const images: WishlistImage[] = Array.isArray(p.images)
    ? (p.images as unknown[])
        .filter(
          (i): i is WishlistImage =>
            !!i && typeof (i as WishlistImage).mime === 'string' && typeof (i as WishlistImage).dataB64 === 'string',
        )
        .map((i) => ({ mime: i.mime, dataB64: i.dataB64 }))
    : [];
  return {
    text: typeof p.text === 'string' ? p.text : '',
    links: Array.isArray(p.links) ? (p.links as unknown[]).filter((l): l is string => typeof l === 'string') : [],
    images,
    updatedAt: updatedAt ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const supabase: SupabaseClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'santa-auth' },
  });

  // In-memory session state. The private key never leaves this closure.
  let me: Participant | null = null;
  let privateKey: CryptoKey | null = null;

  // ----- small helpers -----

  async function fetchParticipant(id: string): Promise<ParticipantRow> {
    const { data, error } = await supabase.from('participants').select(PARTICIPANT_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not load that person.');
    if (!data) throw new BackendError('That person is no longer on the list.', 'not_found');
    return data as ParticipantRow;
  }

  async function participantByUser(userId: string): Promise<ParticipantRow | null> {
    const { data, error } = await supabase
      .from('participants')
      .select(PARTICIPANT_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw dbError(error, 'Could not load your account.');
    return (data as ParticipantRow | null) ?? null;
  }

  async function currentUserId(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  }

  function requireMe(): { me: Participant; key: CryptoKey } {
    if (!me || !privateKey) throw new BackendError('Please log in first.', 'not_logged_in');
    return { me, key: privateKey };
  }

  async function invoke<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });
    if (error) throw await functionError(error, fallback);
    return data as T;
  }

  async function rpc<T = unknown>(fn: string, args: Record<string, unknown> | undefined, fallback: string): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw dbError(error, fallback);
    return data as T;
  }

  /** Stores the unlocked key in memory and (optionally) on this device. */
  async function startSession(p: ParticipantRow, key: CryptoKey, remember: boolean): Promise<Session> {
    me = toParticipant(p);
    privateKey = key;
    if (remember && !key.extractable) {
      await rememberKey(p.id, key);
    } else {
      await forgetKey(p.id);
    }
    return { participant: me };
  }

  async function readMyWrappedKey(participantId: string): Promise<string> {
    const { data, error } = await supabase
      .from('user_keys')
      .select('wrapped_private_key')
      .eq('participant_id', participantId)
      .maybeSingle();
    if (error) throw dbError(error, 'Could not load your keys.');
    if (!data?.wrapped_private_key) {
      throw new BackendError('Your account keys are missing. Ask the admin to reset your account.', 'missing_keys');
    }
    return data.wrapped_private_key as string;
  }

  /** Signs in with an already derived authSecret and unlocks the private key. */
  async function signInAndUnlock(
    p: ParticipantRow,
    authSecret: string,
    kek: CryptoKey,
    remember: boolean,
  ): Promise<Session> {
    me = null;
    privateKey = null;
    const { data, error } = await supabase.auth.signInWithPassword({ email: emailFor(p.id), password: authSecret });
    if (error || !data.session) {
      if (error && /invalid login credentials/i.test(error.message)) {
        throw new BackendError('Wrong password.', 'wrong_password');
      }
      if (error && (error.status === 429 || /rate limit/i.test(error.message))) {
        throw new BackendError('Too many attempts. Please wait a minute and try again.', 'rate_limited');
      }
      if (error && /email not confirmed/i.test(error.message)) {
        throw new BackendError(
          'This account was created while "Confirm email" was on. Ask the admin to disable it in Supabase and reset your account.',
          'email_not_confirmed',
        );
      }
      throw new BackendError('Could not log in. Check your connection and try again.', 'network');
    }
    if (p.user_id && data.session.user.id !== p.user_id) {
      await supabase.auth.signOut();
      throw new BackendError('Wrong password.', 'wrong_password');
    }
    const wrapped = await readMyWrappedKey(p.id);
    let key: CryptoKey;
    try {
      key = await unwrapPrivateKey(wrapped, kek, false);
    } catch {
      await supabase.auth.signOut();
      throw new BackendError('Wrong password.', 'wrong_password');
    }
    return startSession(p, key, remember);
  }

  async function myWishlistKey(participantId: string, key: CryptoKey): Promise<string | null> {
    const { data, error } = await supabase
      .from('wishlist_keys')
      .select('sealed')
      .eq('participant_id', participantId)
      .maybeSingle();
    if (error) throw dbError(error, 'Could not load your wishlist key.');
    if (!data?.sealed) return null;
    try {
      const payload = decodeJson<{ v: number; wishlistKey: string }>(unpad(await openSealed(key, data.sealed as string)));
      return typeof payload.wishlistKey === 'string' ? payload.wishlistKey : null;
    } catch {
      throw new BackendError(
        "Your wishlist key can't be opened with your current account. If your account was reset after the draw, the admin needs to redo the draw.",
        'stale_draw',
      );
    }
  }

  /** Always fetches every wishlist row (privacy: logs must not show whose list is read). */
  async function fetchAllWishlists(): Promise<WishlistRow[]> {
    const { data, error } = await supabase.from('wishlists').select('participant_id, ciphertext, updated_at');
    if (error) throw dbError(error, 'Could not load wishlists.');
    return (data ?? []) as WishlistRow[];
  }

  async function decryptWishlistOf(ownerId: string, wishlistKey: string): Promise<Wishlist | null> {
    const rows = await fetchAllWishlists();
    const row = rows.find((r) => r.participant_id === ownerId);
    if (!row) return null;
    try {
      return parseWishlist(await decryptWithKey(wishlistKey, row.ciphertext), row.updated_at);
    } catch {
      throw new BackendError("This wishlist couldn't be decrypted.", 'decrypt_failed');
    }
  }

  // ----- the Backend -----

  const backend: Backend = {
    mode: 'supabase',

    // ===== Public =====

    async getEvent(): Promise<EventInfo> {
      const [ev, count] = await Promise.all([
        supabase
          .from('event')
          .select('name, budget_amount, currency, exchange_date, status, drawn_at')
          .eq('id', 1)
          .maybeSingle(),
        supabase.from('participants').select('id', { count: 'exact', head: true }),
      ]);
      if (ev.error) throw dbError(ev.error, 'Could not load the event.');
      if (!ev.data) throw new BackendError('The database is not set up yet. The admin needs to run the SQL migration.', 'not_setup');
      if (count.error) throw dbError(count.error, 'Could not load the event.');
      const e = ev.data as EventRow;
      return {
        name: e.name,
        budgetAmount: Number(e.budget_amount),
        currency: e.currency,
        exchangeDate: e.exchange_date,
        status: e.status,
        drawnAt: e.drawn_at,
        bootstrapped: (count.count ?? 0) > 0,
      };
    },

    async listParticipants(): Promise<Participant[]> {
      const { data, error } = await supabase
        .from('participants')
        .select(PARTICIPANT_COLUMNS)
        .order('created_at', { ascending: true });
      if (error) throw dbError(error, 'Could not load the list of people.');
      return ((data ?? []) as ParticipantRow[])
        .map(toParticipant)
        .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name));
    },

    async bootstrap(adminName: string): Promise<void> {
      await rpc('bootstrap', { admin_name: cleanName(adminName) }, 'Could not set up the Secret Santa.');
    },

    // ===== Auth =====

    async claim(participantId, password, remember) {
      checkPassword(password);
      const p = await fetchParticipant(participantId);
      if (p.user_id) {
        throw new BackendError(`${p.name} has already joined. Try logging in instead.`, 'already_claimed');
      }

      // Start from a clean slate on this device.
      me = null;
      privateKey = null;
      await supabase.auth.signOut();

      const kdfSalt = randomSaltB64();
      const recoverySalt = randomSaltB64();
      const { authSecret, kek } = await deriveFromPassword(password, kdfSalt);
      const { publicJwk, privateKey: extractableKey } = await generateUserKeyPair();
      const wrapped = await wrapPrivateKey(extractableKey, kek);
      const recoveryCode = generateRecoveryCode();
      const { recoveryAuth, kek: recoveryKek } = await deriveFromRecoveryCode(recoveryCode, recoverySalt);
      const recoveryWrapped = await wrapPrivateKey(extractableKey, recoveryKek);
      const recoveryAuthHash = await sha256Hex(recoveryAuth);

      const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
        email: emailFor(participantId),
        password: authSecret,
      });
      if (signUpErr) {
        if (/already registered|already exists/i.test(signUpErr.message)) {
          throw new BackendError(
            'A previous attempt to join with this name did not finish. Ask the admin to reset your account, then try again.',
            'stale_signup',
          );
        }
        if (signUpErr.status === 429 || /rate limit/i.test(signUpErr.message)) {
          throw new BackendError('Too many attempts. Please wait a minute and try again.', 'rate_limited');
        }
        if (/signups? not allowed|disabled/i.test(signUpErr.message)) {
          throw new BackendError(
            'Sign-ups are disabled. The admin needs to enable email sign-ups in Supabase (Authentication → Providers → Email).',
            'signup_disabled',
          );
        }
        throw new BackendError('Could not create your account. Check your connection and try again.');
      }
      if (!signUp.session) {
        throw new BackendError(
          '"Confirm email" is enabled in Supabase. The admin needs to turn it off (Authentication → Providers → Email → Confirm email), reset your account, and then you can join.',
          'confirm_email_enabled',
        );
      }

      const { error: claimErr } = await supabase.rpc('claim_participant', {
        p_id: participantId,
        p_kdf_salt: kdfSalt,
        p_recovery_salt: recoverySalt,
        p_public_key: publicJwk,
        p_wrapped_private_key: wrapped,
        p_recovery_wrapped_private_key: recoveryWrapped,
        p_recovery_auth_hash: recoveryAuthHash,
      });
      if (claimErr) {
        await supabase.auth.signOut();
        throw dbError(claimErr, 'Could not save your account. Please try again.');
      }

      // Keep only a non-extractable copy of the key in memory / on the device.
      const key = await unwrapPrivateKey(wrapped, kek, false);
      const session = await startSession({ ...p, user_id: signUp.session.user.id, kdf_salt: kdfSalt }, key, remember);
      return { session, recoveryCode };
    },

    async login(participantId, password, remember) {
      if (!password) throw new BackendError('Wrong password.', 'wrong_password');
      const p = await fetchParticipant(participantId);
      if (!p.user_id || !p.kdf_salt) {
        throw new BackendError(`${p.name} hasn't joined yet. Pick "first time" to set a password.`, 'not_claimed');
      }
      const { authSecret, kek } = await deriveFromPassword(password, p.kdf_salt);
      return signInAndUnlock(p, authSecret, kek, remember);
    },

    async restoreSession() {
      const userId = await currentUserId();
      if (!userId) {
        me = null;
        privateKey = null;
        return null;
      }
      let p: ParticipantRow | null;
      try {
        p = await participantByUser(userId);
      } catch {
        return me && privateKey ? { participant: me } : 'locked';
      }
      if (!p) {
        // Account was reset or never finished claiming.
        me = null;
        privateKey = null;
        await supabase.auth.signOut();
        return null;
      }
      if (me && privateKey && me.id === p.id) {
        me = toParticipant(p);
        return { participant: me };
      }
      const remembered = await recallKey(p.id);
      if (remembered) {
        me = toParticipant(p);
        privateKey = remembered;
        return { participant: me };
      }
      me = toParticipant(p);
      privateKey = null;
      return 'locked';
    },

    async unlock(password, remember) {
      const userId = await currentUserId();
      if (!userId) throw new BackendError('Your session has expired. Please log in again.', 'not_logged_in');
      const p = await participantByUser(userId);
      if (!p || !p.kdf_salt) {
        await supabase.auth.signOut();
        throw new BackendError('Your session has expired. Please log in again.', 'not_logged_in');
      }
      const { kek } = await deriveFromPassword(password ?? '', p.kdf_salt);
      const wrapped = await readMyWrappedKey(p.id);
      let key: CryptoKey;
      try {
        key = await unwrapPrivateKey(wrapped, kek, false);
      } catch {
        throw new BackendError('Wrong password.', 'wrong_password');
      }
      return startSession(p, key, remember);
    },

    async logout() {
      me = null;
      privateKey = null;
      await forgetAllKeys();
      await supabase.auth.signOut();
    },

    async changePassword(oldPassword, newPassword) {
      const { me: current } = requireMe();
      checkPassword(newPassword);
      const p = await fetchParticipant(current.id);
      if (!p.kdf_salt) throw new BackendError('Please log in again.', 'not_logged_in');

      const oldDerived = await deriveFromPassword(oldPassword ?? '', p.kdf_salt);
      const wrapped = await readMyWrappedKey(p.id);
      let extractable: CryptoKey;
      try {
        extractable = await unwrapPrivateKey(wrapped, oldDerived.kek, true);
      } catch {
        throw new BackendError('Your current password is not right.', 'wrong_password');
      }

      const newSalt = randomSaltB64();
      const { authSecret, kek } = await deriveFromPassword(newPassword, newSalt);
      const newWrapped = await wrapPrivateKey(extractable, kek);

      const { error: pwErr } = await supabase.auth.updateUser({ password: authSecret });
      if (pwErr) {
        if (/reauthenticat/i.test(pwErr.message)) {
          throw new BackendError(
            'Supabase requires re-authentication for password changes. The admin should turn off "Secure password change" in Supabase Auth settings.',
          );
        }
        throw new BackendError('Could not change your password. Please try again.');
      }
      const { error: keysErr } = await supabase.rpc('update_my_keys', {
        p_kdf_salt: newSalt,
        p_wrapped_private_key: newWrapped,
      });
      if (keysErr) {
        // Put the old Supabase password back so the old password keeps working.
        await supabase.auth.updateUser({ password: oldDerived.authSecret });
        throw dbError(keysErr, 'Could not change your password. Please try again.');
      }
      // The RSA key itself is unchanged, so a remembered (non-extractable) key stays valid.
    },

    async recover(participantId, recoveryCode, newPassword) {
      checkPassword(newPassword);
      const p = await fetchParticipant(participantId);
      if (!p.user_id || !p.recovery_salt) {
        throw new BackendError(`${p.name} hasn't joined yet.`, 'not_claimed');
      }
      const { recoveryAuth, kek: recoveryKek } = await deriveFromRecoveryCode(recoveryCode ?? '', p.recovery_salt);
      const fetched = await invoke<{ recoveryWrappedPrivateKey?: string }>(
        { action: 'recover_fetch', participantId, recoveryAuth },
        "That recovery code doesn't match. Check it and try again.",
      );
      if (!fetched?.recoveryWrappedPrivateKey) {
        throw new BackendError("That recovery code doesn't match. Check it and try again.", 'wrong_recovery');
      }
      let extractable: CryptoKey;
      try {
        extractable = await unwrapPrivateKey(fetched.recoveryWrappedPrivateKey, recoveryKek, true);
      } catch {
        throw new BackendError("That recovery code doesn't match. Check it and try again.", 'wrong_recovery');
      }

      const kdfSalt = randomSaltB64();
      const { authSecret, kek } = await deriveFromPassword(newPassword, kdfSalt);
      const wrappedPrivateKey = await wrapPrivateKey(extractable, kek);
      await invoke(
        { action: 'recover_reset', participantId, recoveryAuth, authSecret, kdfSalt, wrappedPrivateKey },
        'Could not reset your password. Please try again.',
      );

      await supabase.auth.signOut();
      return signInAndUnlock({ ...p, kdf_salt: kdfSalt }, authSecret, kek, false);
    },

    // ===== Logged in =====

    async getMyPreferences(): Promise<Preferences> {
      const { me: current } = requireMe();
      const { data, error } = await supabase
        .from('preferences')
        .select('no_give_to, no_receive_from')
        .eq('participant_id', current.id)
        .maybeSingle();
      if (error) throw dbError(error, 'Could not load your preferences.');
      return {
        noGiveTo: (data?.no_give_to as string | null | undefined) ?? null,
        noReceiveFrom: (data?.no_receive_from as string | null | undefined) ?? null,
      };
    },

    async setMyPreferences(prefs: Preferences): Promise<void> {
      requireMe();
      await rpc(
        'set_my_preferences',
        { p_no_give_to: prefs.noGiveTo || null, p_no_receive_from: prefs.noReceiveFrom || null },
        'Could not save your preferences.',
      );
    },

    async getMyAssignment(): Promise<Assignment | null> {
      const { me: current, key } = requireMe();
      const { data, error } = await supabase
        .from('assignments')
        .select('sealed')
        .eq('giver_id', current.id)
        .maybeSingle();
      if (error) throw dbError(error, 'Could not load your assignment.');
      if (!data?.sealed) return null;

      let receiverId: string;
      let wishlistKey: string;
      try {
        const payload = decodeJson<{ v: number; receiverId: string; wishlistKey: string }>(
          unpad(await openSealed(key, data.sealed as string)),
        );
        receiverId = payload.receiverId;
        wishlistKey = payload.wishlistKey;
      } catch {
        throw new BackendError(
          "Your assignment can't be opened with your current account. If your account was reset after the draw, the admin needs to redo the draw.",
          'stale_draw',
        );
      }

      // Fetch the whole list, never filter by receiverId: a filtered request would
      // put "giver → receiver" into the Supabase request logs.
      const { data: everyone, error: rErr } = await supabase.from('participants').select('id, name');
      if (rErr) throw dbError(rErr, 'Could not load your assignment.');
      const receiver = (everyone ?? []).find((p) => p.id === receiverId);

      return {
        receiverId,
        receiverName: (receiver?.name as string | undefined) ?? 'someone who left the list',
        wishlist: await decryptWishlistOf(receiverId, wishlistKey),
      };
    },

    async getMyWishlist(): Promise<Wishlist | null> {
      const { me: current, key } = requireMe();
      const wk = await myWishlistKey(current.id, key);
      if (!wk) return null;
      return decryptWishlistOf(current.id, wk);
    },

    async saveMyWishlist(wishlist: Wishlist): Promise<void> {
      const { me: current, key } = requireMe();
      const images = wishlist.images ?? [];
      const links = (wishlist.links ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
      if (images.length > MAX_WISHLIST_IMAGES) {
        throw new BackendError(`You can add up to ${MAX_WISHLIST_IMAGES} pictures.`);
      }
      for (const l of links) {
        if (!/^https?:\/\//i.test(l)) throw new BackendError(`"${l}" doesn't look like a web link.`);
      }
      const wk = await myWishlistKey(current.id, key);
      if (!wk) throw new BackendError('Wishlists open once the names are drawn.', 'not_drawn');
      const payload = {
        v: 1,
        text: wishlist.text ?? '',
        links,
        images: images.map((i) => ({ mime: i.mime, dataB64: i.dataB64 })),
      };
      const ciphertext = await encryptWithKey(wk, encodeJson(payload));
      await rpc('save_my_wishlist', { p_ciphertext: ciphertext }, 'Could not save your wishlist.');
    },

    async listGroupPhotos(): Promise<GroupPhoto[]> {
      if (!(await currentUserId())) return [];
      const { data, error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
      if (error) throw new BackendError('Could not load the group photos.');
      const files = (data ?? [])
        .filter((f) => f.id && f.name && !f.name.startsWith('.'))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      if (files.length === 0) return [];
      const { data: signed, error: sErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrls(
          files.map((f) => f.name),
          SIGNED_URL_SECONDS,
        );
      if (sErr || !signed) throw new BackendError('Could not load the group photos.');
      const urlByPath = new Map<string, string>();
      for (const s of signed) if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
      return files
        .filter((f) => urlByPath.has(f.name))
        .map((f) => ({ id: f.name, url: urlByPath.get(f.name)! }));
    },

    // ===== Admin =====

    async updateEvent(patch: EventPatch): Promise<void> {
      const current = await backend.getEvent();
      const name = (patch.name ?? current.name).trim();
      if (!name) throw new BackendError('The event needs a name.');
      const budget = patch.budgetAmount ?? current.budgetAmount;
      if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
        throw new BackendError('The budget must be zero or more.');
      }
      const currency = (patch.currency ?? current.currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new BackendError('The currency must be a 3-letter code like CHF or EUR.');
      }
      const exchangeDate = patch.exchangeDate !== undefined ? patch.exchangeDate || null : current.exchangeDate;
      if (exchangeDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(exchangeDate)) {
        throw new BackendError('Please pick a valid date.');
      }
      await rpc(
        'admin_update_event',
        { p_name: name, p_budget_amount: budget, p_currency: currency, p_exchange_date: exchangeDate },
        'Could not save the event.',
      );
    },

    async addParticipant(name: string): Promise<void> {
      await rpc('admin_add_participant', { p_name: cleanName(name) }, 'Could not add that person.');
    },

    async renameParticipant(id: string, name: string): Promise<void> {
      await rpc('admin_rename_participant', { p_id: id, p_name: cleanName(name) }, 'Could not rename that person.');
    },

    async removeParticipant(id: string): Promise<void> {
      await rpc('admin_remove_participant', { p_id: id }, 'Could not remove that person.');
    },

    async resetParticipant(id: string): Promise<{ needsRedraw: boolean }> {
      const res = await invoke<{ needsRedraw?: boolean }>(
        { action: 'admin_reset_participant', participantId: id },
        "Could not reset that person's account.",
      );
      return { needsRedraw: res?.needsRedraw === true };
    },

    async draw(): Promise<void> {
      await invoke({ action: 'draw' }, 'The draw failed. Please try again.');
    },

    async resetDraw(): Promise<void> {
      await rpc('reset_draw', undefined, 'Could not reset the draw.');
    },

    async uploadGroupPhoto(file: Blob): Promise<void> {
      const type = file.type || 'image/jpeg';
      if (!type.startsWith('image/')) throw new BackendError('Only pictures can be uploaded.');
      const ext =
        ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[
          type
        ] ?? 'img';
      const name = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(name, file, { contentType: type, upsert: false, cacheControl: '3600' });
      if (error) {
        if (/row-level security|unauthorized|403/i.test(error.message)) {
          throw new BackendError('Only the admin can upload group photos.', 'forbidden');
        }
        if (/too large|maximum allowed size|payload/i.test(error.message)) {
          throw new BackendError('That picture is too large.');
        }
        throw new BackendError('Could not upload the photo. Please try again.');
      }
    },

    async deleteGroupPhoto(id: string): Promise<void> {
      if (!id || id.includes('/') || id.startsWith('.')) throw new BackendError('Unknown photo.');
      const { data, error } = await supabase.storage.from(PHOTO_BUCKET).remove([id]);
      if (error) throw new BackendError('Could not delete the photo. Please try again.');
      if (!data || data.length === 0) throw new BackendError('Only the admin can delete group photos.', 'forbidden');
    },
  };

  return backend;
}
