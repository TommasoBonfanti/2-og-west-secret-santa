// Supabase Edge Function "santa": draw, password recovery and admin account reset.
//
// Deploy (from the repository root):
//   npx supabase functions deploy santa --project-ref YOUR-PROJECT-REF
// Optional CORS restriction (comma-separated list allowed):
//   npx supabase secrets set ALLOWED_ORIGIN=https://YOUR-USER.github.io --project-ref YOUR-PROJECT-REF
// If the project uses the new non-JWT "publishable" API keys instead of the legacy
// anon JWT key, deploy with --no-verify-jwt (this function authenticates callers itself).
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase automatically.
//
// PRIVACY: this function never logs, stores in plaintext or returns who gifts whom.
// The assignment exists in plaintext only in this function's memory during a draw.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { encodeJson, generateSymmetricKeyB64, pad, sealTo, sha256Hex } from '../_shared/crypto.ts';
import { DrawImpossibleError, MIN_PARTICIPANTS, drawAssignment, type DrawInput } from '../_shared/draw.ts';

const SEALED_PAYLOAD_SIZE = 256;
const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGIN') ?? '*')
  .split(',')
  .map((s: string) => s.trim())
  .filter((s: string) => s.length > 0);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  let allow = '*';
  if (!allowedOrigins.includes('*') && allowedOrigins.length > 0) {
    allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Constant-time comparison of two strings (length is not secret here: both are hex SHA-256). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireString(body: Record<string, unknown>, key: string, re: RegExp, maxLen: number): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen || !re.test(v)) {
    throw new HttpError(400, 'Invalid request.');
  }
  return v;
}

function requireUuid(body: Record<string, unknown>, key: string): string {
  return requireString(body, key, UUID_RE, 36).toLowerCase();
}

/** Verifies the caller's JWT and that they are the admin participant. Returns the admin participant id. */
async function requireAdmin(req: Request, db: SupabaseClient): Promise<string> {
  const header = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new HttpError(401, 'Please sign in again.');
  const { data, error } = await db.auth.getUser(m[1]);
  if (error || !data?.user) throw new HttpError(401, 'Please sign in again.');
  const { data: p, error: pErr } = await db
    .from('participants')
    .select('id, is_admin')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (pErr) throw new Error('participants lookup failed');
  if (!p || p.is_admin !== true) throw new HttpError(403, 'Only the admin can do this.');
  return p.id as string;
}

/** Loads and verifies recovery data. Throws a generic 400 on any mismatch. */
async function verifyRecovery(
  db: SupabaseClient,
  participantId: string,
  recoveryAuth: string,
): Promise<{ userId: string; recoveryWrappedPrivateKey: string }> {
  const generic = new HttpError(400, 'That recovery code is not valid for this name.');
  const { data: p, error: pErr } = await db
    .from('participants')
    .select('id, user_id')
    .eq('id', participantId)
    .maybeSingle();
  if (pErr) throw new Error('participants lookup failed');
  const { data: k, error: kErr } = await db
    .from('user_keys')
    .select('recovery_wrapped_private_key, recovery_auth_hash')
    .eq('participant_id', participantId)
    .maybeSingle();
  if (kErr) throw new Error('user_keys lookup failed');
  // Always hash, so timing doesn't reveal whether the participant exists.
  const hash = await sha256Hex(recoveryAuth);
  const stored = typeof k?.recovery_auth_hash === 'string' ? k.recovery_auth_hash : '0'.repeat(64);
  const ok = timingSafeEqual(hash, stored);
  if (!ok || !p?.user_id || !k) throw generic;
  return { userId: p.user_id as string, recoveryWrappedPrivateKey: k.recovery_wrapped_private_key as string };
}

async function findAuthUserIdByEmail(db: SupabaseClient, email: string): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error('auth user lookup failed');
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < perPage) break;
  }
  return null;
}

const NIL_UUID ='00000000-0000-0000-0000-000000000000';

async function wipeDrawRows(db: SupabaseClient): Promise<void> {
  // PostgREST requires a filter on DELETE; these match every row.
  const a = await db.from('assignments').delete().neq('giver_id', NIL_UUID);
  const k = await db.from('wishlist_keys').delete().neq('participant_id', NIL_UUID);
  const w = await db.from('wishlists').delete().neq('participant_id', NIL_UUID);
  if (a.error || k.error || w.error) throw new Error('could not clear previous draw rows');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionDraw(req: Request, db: SupabaseClient): Promise<unknown> {
  await requireAdmin(req, db);

  // Claim the draw atomically: only one caller can flip open -> drawn.
  // While the status is 'drawn', the database rejects new participants,
  // preference changes and renames.
  const { data: claimed, error: claimErr } = await db
    .from('event')
    .update({ status: 'drawn', drawn_at: null })
    .eq('id', 1)
    .eq('status', 'open')
    .select('id');
  if (claimErr) throw new Error('event update failed');
  if (!claimed || claimed.length !== 1) {
    throw new HttpError(409, 'The names have already been drawn. Reset the draw first to draw again.');
  }

  try {
    const { data: people, error: peopleErr } = await db
      .from('participants')
      .select('id, name, user_id, public_key')
      .order('id', { ascending: true });
    if (peopleErr || !people) throw new Error('participants lookup failed');

    if (people.length < MIN_PARTICIPANTS) {
      throw new HttpError(400, `At least ${MIN_PARTICIPANTS} people are needed for the draw.`);
    }
    const notJoined = people.filter((p) => !p.user_id || !p.public_key).map((p) => p.name as string);
    if (notJoined.length > 0) {
      throw new HttpError(400, `Not everyone has joined yet. Still waiting for: ${notJoined.join(', ')}.`);
    }

    const { data: prefs, error: prefsErr } = await db
      .from('preferences')
      .select('participant_id, no_give_to, no_receive_from');
    if (prefsErr || !prefs) throw new Error('preferences lookup failed');

    const ids: string[] = people.map((p) => p.id as string).sort();
    const idSet = new Set(ids);
    const input: DrawInput = { ids, noGiveTo: {}, noReceiveFrom: {} };
    for (const row of prefs) {
      const pid = row.participant_id as string;
      if (!idSet.has(pid)) continue;
      if (row.no_give_to && idSet.has(row.no_give_to)) input.noGiveTo[pid] = row.no_give_to as string;
      if (row.no_receive_from && idSet.has(row.no_receive_from)) {
        input.noReceiveFrom[pid] = row.no_receive_from as string;
      }
    }

    let assignment: Map<string, string>;
    try {
      assignment = drawAssignment(input);
    } catch (e) {
      if (e instanceof DrawImpossibleError) {
        throw new HttpError(
          400,
          'No valid draw is possible with the current preferences. Ask people to relax their preferences and try again.',
        );
      }
      throw e;
    }

    const publicKeys = new Map<string, JsonWebKey>(
      people.map((p) => [p.id as string, p.public_key as JsonWebKey]),
    );

    // One fresh wishlist key per receiver. Rows are built and inserted in id
    // order (not pair order) so row order / timestamps reveal nothing.
    const wishlistKeyOf = new Map<string, string>();
    for (const id of ids) wishlistKeyOf.set(id, generateSymmetricKeyB64());

    const assignmentRows: { giver_id: string; sealed: string }[] = [];
    const wishlistKeyRows: { participant_id: string; sealed: string }[] = [];
    for (const id of ids) {
      const receiverId = assignment.get(id)!;
      assignmentRows.push({
        giver_id: id,
        sealed: await sealTo(
          publicKeys.get(id)!,
          pad(encodeJson({ v: 1, receiverId, wishlistKey: wishlistKeyOf.get(receiverId)! }), SEALED_PAYLOAD_SIZE),
        ),
      });
      wishlistKeyRows.push({
        participant_id: id,
        sealed: await sealTo(
          publicKeys.get(id)!,
          pad(encodeJson({ v: 1, wishlistKey: wishlistKeyOf.get(id)! }), SEALED_PAYLOAD_SIZE),
        ),
      });
    }
    assignment.clear();
    wishlistKeyOf.clear();

    await wipeDrawRows(db);
    const insA = await db.from('assignments').insert(assignmentRows);
    if (insA.error) throw new Error('assignments insert failed');
    const insK = await db.from('wishlist_keys').insert(wishlistKeyRows);
    if (insK.error) throw new Error('wishlist_keys insert failed');

    const { error: doneErr } = await db
      .from('event')
      .update({ drawn_at: new Date().toISOString() })
      .eq('id', 1);
    if (doneErr) throw new Error('event update failed');

    return { ok: true };
  } catch (e) {
    // Roll back: remove anything written and reopen the event.
    try {
      await wipeDrawRows(db);
    } catch {
      // ignore; the admin can use "reset draw"
    }
    await db.from('event').update({ status: 'open', drawn_at: null }).eq('id', 1);
    throw e;
  }
}

async function actionRecoverFetch(body: Record<string, unknown>, db: SupabaseClient): Promise<unknown> {
  const participantId = requireUuid(body, 'participantId');
  const recoveryAuth = requireString(body, 'recoveryAuth', HEX64_RE, 64);
  const { recoveryWrappedPrivateKey } = await verifyRecovery(db, participantId, recoveryAuth);
  return { recoveryWrappedPrivateKey };
}

async function actionRecoverReset(body: Record<string, unknown>, db: SupabaseClient): Promise<unknown> {
  const participantId = requireUuid(body, 'participantId');
  const recoveryAuth = requireString(body, 'recoveryAuth', HEX64_RE, 64);
  const authSecret = requireString(body, 'authSecret', HEX64_RE, 64);
  const kdfSalt = requireString(body, 'kdfSalt', B64_RE, 100);
  const wrappedPrivateKey = requireString(body, 'wrappedPrivateKey', /^w1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/, 20000);

  const { userId } = await verifyRecovery(db, participantId, recoveryAuth);

  const { error: keyErr } = await db
    .from('user_keys')
    .update({ wrapped_private_key: wrappedPrivateKey, updated_at: new Date().toISOString() })
    .eq('participant_id', participantId);
  if (keyErr) throw new Error('user_keys update failed');
  const { error: saltErr } = await db.from('participants').update({ kdf_salt: kdfSalt }).eq('id', participantId);
  if (saltErr) throw new Error('participants update failed');

  // If this fails the user can simply run recovery again (the recovery-wrapped key is untouched).
  const { error: pwErr } = await db.auth.admin.updateUserById(userId, { password: authSecret });
  if (pwErr) throw new Error('password update failed');

  return { ok: true };
}

async function actionAdminResetParticipant(
  req: Request,
  body: Record<string, unknown>,
  db: SupabaseClient,
): Promise<unknown> {
  const adminId = await requireAdmin(req, db);
  const participantId = requireUuid(body, 'participantId');
  if (participantId === adminId) {
    throw new HttpError(400, "You can't reset your own account. Use your recovery code instead.");
  }

  const { data: p, error: pErr } = await db
    .from('participants')
    .select('id, user_id')
    .eq('id', participantId)
    .maybeSingle();
  if (pErr) throw new Error('participants lookup failed');
  if (!p) throw new HttpError(404, 'Unknown participant.');

  // The linked auth user, or an orphan left by a sign-up whose claim never finished.
  let authUserId: string | null = (p.user_id as string | null) ?? null;
  if (!authUserId) authUserId = await findAuthUserIdByEmail(db, `p-${participantId}@example.com`);
  if (authUserId) {
    const { error: delErr } = await db.auth.admin.deleteUser(authUserId);
    // A missing auth user is fine (already gone); anything else is a failure.
    if (delErr && (delErr as { status?: number }).status !== 404) throw new Error('auth user delete failed');
  }

  const { error: upErr } = await db
    .from('participants')
    .update({ user_id: null, kdf_salt: null, recovery_salt: null, public_key: null })
    .eq('id', participantId);
  if (upErr) throw new Error('participants update failed');
  const k = await db.from('user_keys').delete().eq('participant_id', participantId);
  const pr = await db.from('preferences').delete().eq('participant_id', participantId);
  if (k.error || pr.error) throw new Error('cleanup failed');

  const { data: ev, error: evErr } = await db.from('event').select('status').eq('id', 1).single();
  if (evErr) throw new Error('event lookup failed');
  return { needsRedraw: ev?.status === 'drawn' };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed.' });

  let action = '';
  try {
    const len = Number(req.headers.get('Content-Length') ?? '0');
    if (len > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Invalid request.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
    const b = body as Record<string, unknown>;
    action = typeof b.action === 'string' ? b.action : '';

    const db = serviceClient();
    let result: unknown;
    switch (action) {
      case 'draw':
        result = await actionDraw(req, db);
        break;
      case 'recover_fetch':
        result = await actionRecoverFetch(b, db);
        break;
      case 'recover_reset':
        result = await actionRecoverReset(b, db);
        break;
      case 'admin_reset_participant':
        result = await actionAdminResetParticipant(req, b, db);
        break;
      default:
        throw new HttpError(400, 'Unknown action.');
    }
    return json(req, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    // Log only the action and a short, pair-free message. Never log request bodies or draw data.
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.error(`santa: action "${action}" failed: ${action === 'draw' ? 'internal error' : msg}`);
    return json(req, 500, { error: 'Something went wrong. Please try again.' });
  }
});
