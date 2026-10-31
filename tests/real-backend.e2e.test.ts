// End-to-end test against a REAL Supabase project (the one in .env.local).
// Skipped unless E2E_REAL=1. It creates test accounts: wipe them afterwards
// with the cleanup SQL in docs/SETUP.md. Never run it against a live event.
//
//   $env:E2E_REAL=1; npx vitest run tests/real-backend.e2e.test.ts
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseBackend } from '../src/api/supabaseBackend';
import type { Backend } from '../src/api/backend';
import { deriveFromPassword } from '../supabase/functions/_shared/crypto';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const enabled = process.env.E2E_REAL === '1' && !!url && !!key;

const NAMES = ['E2E Admin', 'E2E Bea', 'E2E Carlo', 'E2E Dani', 'E2E Ema'];
const pw = (name: string) => `test pass ${name} sled`;

/** A raw client logged in as `name`, to probe the database directly. */
async function rawClientAs(name: string, password = pw(name)) {
  const anon = createClient(url, key, { auth: { persistSession: false } });
  const { data } = await anon.from('participants').select('id, kdf_salt').eq('name', name).single();
  const { authSecret } = await deriveFromPassword(password, data!.kdf_salt as string);
  const c = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `p-${data!.id}@example.com`, password: authSecret });
  if (error) throw error;
  return c;
}

describe.skipIf(!enabled)('real Supabase backend', () => {
  const backends = new Map<string, Backend>();
  const ids = new Map<string, string>();
  const codes = new Map<string, string>();
  const nameOf = (id: string) => [...ids].find(([, v]) => v === id)![0];

  it('bootstraps, adds and claims everyone', async () => {
    const admin = createSupabaseBackend(url, key);
    expect((await admin.getEvent()).bootstrapped).toBe(false);
    await admin.bootstrap(NAMES[0]);
    let list = await admin.listParticipants();
    ids.set(NAMES[0], list[0].id);
    const { recoveryCode } = await admin.claim(list[0].id, pw(NAMES[0]), false);
    codes.set(NAMES[0], recoveryCode);
    backends.set(NAMES[0], admin);

    for (const n of NAMES.slice(1)) await admin.addParticipant(n);
    list = await admin.listParticipants();
    for (const n of NAMES.slice(1)) {
      const p = list.find((x) => x.name === n)!;
      ids.set(n, p.id);
      const b = createSupabaseBackend(url, key);
      const r = await b.claim(p.id, pw(n), false);
      codes.set(n, r.recoveryCode);
      backends.set(n, b);
    }
    expect((await admin.listParticipants()).every((p) => p.claimed)).toBe(true);
  });

  it('rejects a wrong password and a second claim', async () => {
    const b = createSupabaseBackend(url, key);
    await expect(b.login(ids.get(NAMES[1])!, 'definitely wrong pw', false)).rejects.toThrow();
    await expect(b.claim(ids.get(NAMES[1])!, 'another password!!', false)).rejects.toThrow();
  });

  it('non-admins cannot do admin things', async () => {
    const bea = backends.get(NAMES[1])!;
    await expect(bea.addParticipant('Intruder')).rejects.toThrow();
    await expect(bea.draw()).rejects.toThrow();
    await expect(bea.resetParticipant(ids.get(NAMES[2])!)).rejects.toThrow();
    await expect(bea.updateEvent({ budgetAmount: 1000 })).rejects.toThrow();
  });

  it('saves preferences and keeps them private', async () => {
    const bea = backends.get(NAMES[1])!;
    await bea.setMyPreferences({ noGiveTo: ids.get(NAMES[2])!, noReceiveFrom: null });
    expect((await bea.getMyPreferences()).noGiveTo).toBe(ids.get(NAMES[2]));
    const carloRaw = await rawClientAs(NAMES[2]);
    const { data } = await carloRaw.from('preferences').select('*');
    expect((data ?? []).every((r) => r.participant_id === ids.get(NAMES[2]))).toBe(true);
  });

  it('draws a valid, secret assignment', async () => {
    const admin = backends.get(NAMES[0])!;
    await admin.draw();
    await expect(admin.draw()).rejects.toThrow();

    const pairs = new Map<string, string>();
    for (const n of NAMES) {
      const a = await backends.get(n)!.getMyAssignment();
      expect(a).not.toBeNull();
      expect(a!.receiverName).toBe(nameOf(a!.receiverId));
      pairs.set(ids.get(n)!, a!.receiverId);
    }
    const receivers = new Set(pairs.values());
    expect(receivers.size).toBe(NAMES.length);
    for (const [g, r] of pairs) {
      expect(g).not.toBe(r);
      expect(pairs.get(r)).not.toBe(g); // no swaps
    }
    expect(pairs.get(ids.get(NAMES[1])!)).not.toBe(ids.get(NAMES[2])); // Bea's preference
  });

  it('nobody can read other people\'s assignments or keys', async () => {
    const adminRaw = await rawClientAs(NAMES[0]);
    for (const table of ['assignments', 'wishlist_keys', 'user_keys', 'preferences']) {
      const col = table === 'assignments' ? 'giver_id' : 'participant_id';
      const { data } = await adminRaw.from(table).select(col);
      const rows = (data ?? []) as unknown as Record<string, string>[];
      expect(rows.every((r) => r[col] === ids.get(NAMES[0]))).toBe(true);
    }
    const anon = createClient(url, key, { auth: { persistSession: false } });
    for (const table of ['assignments', 'wishlist_keys', 'user_keys', 'preferences', 'wishlists']) {
      const { data } = await anon.from(table).select('*');
      expect(data ?? []).toHaveLength(0);
    }
  });

  it('wishlists reach only the Santa', async () => {
    // Find who gifts Carlo, then Carlo writes a wishlist.
    const carlo = backends.get(NAMES[2])!;
    await carlo.saveMyWishlist({ text: 'A red scarf', links: ['https://example.com/scarf'], images: [] });
    expect((await carlo.getMyWishlist())!.text).toBe('A red scarf');
    let santaSaw = 0;
    for (const n of NAMES) {
      const a = await backends.get(n)!.getMyAssignment();
      if (a!.receiverId === ids.get(NAMES[2])) {
        expect(a!.wishlist!.text).toBe('A red scarf');
        santaSaw++;
      } else if (a!.wishlist) {
        expect(a!.wishlist.text).not.toBe('A red scarf');
      }
    }
    expect(santaSaw).toBe(1);
    const raw = await rawClientAs(NAMES[1]);
    const { data } = await raw.from('wishlists').select('ciphertext');
    expect(JSON.stringify(data)).not.toContain('scarf');
  });

  it('recovers with the recovery code and keeps the assignment', async () => {
    const dani = NAMES[3];
    const before = await backends.get(dani)!.getMyAssignment();
    const fresh = createSupabaseBackend(url, key);
    await expect(fresh.recover(ids.get(dani)!, 'WRONG-CODE-0000-0000', 'new password for dani')).rejects.toThrow();
    await fresh.recover(ids.get(dani)!, codes.get(dani)!.toLowerCase(), 'new password for dani');
    const after = await fresh.getMyAssignment();
    expect(after!.receiverId).toBe(before!.receiverId);
    const again = createSupabaseBackend(url, key);
    await again.login(ids.get(dani)!, 'new password for dani', false);
    await expect(createSupabaseBackend(url, key).login(ids.get(dani)!, pw(dani), false)).rejects.toThrow();
  });

  it('changes password', async () => {
    const ema = backends.get(NAMES[4])!;
    await ema.changePassword(pw(NAMES[4]), 'changed password for ema');
    const b = createSupabaseBackend(url, key);
    await b.login(ids.get(NAMES[4])!, 'changed password for ema', false);
    expect(await b.getMyAssignment()).not.toBeNull();
  });

  it('admin reset and redraw work', async () => {
    const admin = backends.get(NAMES[0])!;
    expect((await admin.resetParticipant(ids.get(NAMES[4])!)).needsRedraw).toBe(true);
    await admin.resetDraw();
    expect((await admin.getEvent()).status).toBe('open');
    expect(await admin.getMyAssignment()).toBeNull();
    const ema = createSupabaseBackend(url, key);
    await ema.claim(ids.get(NAMES[4])!, 'rejoined password ema', false);
    await admin.draw();
    expect(await ema.getMyAssignment()).not.toBeNull();
  });
});

describe.skipIf(!enabled)('real Supabase group photos', () => {
  it('admin uploads, everyone sees, others cannot upload', async () => {
    const anon = createClient(url, key, { auth: { persistSession: false } });
    const { data: people } = await anon.from('participants').select('id, name');
    const idOf = (n: string) => people!.find((p) => p.name === n)!.id as string;
    const admin = createSupabaseBackend(url, key);
    await admin.login(idOf(NAMES[0]), pw(NAMES[0]), false);
    const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    await admin.uploadGroupPhoto(new Blob([pixel], { type: 'image/png' }));
    const bea = createSupabaseBackend(url, key);
    await bea.login(idOf(NAMES[1]), pw(NAMES[1]), false);
    const seen = await bea.listGroupPhotos();
    expect(seen.length).toBeGreaterThan(0);
    expect((await fetch(seen[0].url)).status).toBe(200);
    await expect(bea.uploadGroupPhoto(new Blob([pixel], { type: 'image/png' }))).rejects.toThrow();
    await bea.deleteGroupPhoto(seen[0].id).catch(() => undefined);
    expect((await bea.listGroupPhotos()).length).toBe(seen.length); // delete by non-admin has no effect
    expect(await createSupabaseBackend(url, key).listGroupPhotos()).toHaveLength(0); // logged out
    for (const p of await admin.listGroupPhotos()) await admin.deleteGroupPhoto(p.id);
    expect(await admin.listGroupPhotos()).toHaveLength(0);
  });
});
