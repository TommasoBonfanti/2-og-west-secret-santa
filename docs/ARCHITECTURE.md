# 2 OG WEST Secret Santa 2026 — Architecture

Static site (Vite + React + TypeScript) on GitHub Pages, with Supabase as the
backend (Postgres + Auth + Storage + one Edge Function). All secrets that must
stay private from the admin are encrypted in the browser. See `SECURITY.md`.

## Repository layout and ownership

```
index.html                         page shell, Google Fonts
src/
  main.tsx, App.tsx                app entry + tiny hash router          (UI)
  types.ts                         shared domain types                   (contract, fixed)
  config.ts                        env config                            (contract, fixed)
  api/backend.ts                   Backend interface                     (contract, fixed)
  api/index.ts                     picks demo or supabase backend        (contract, fixed)
  api/supabaseBackend.ts           real backend adapter                  (backend)
  api/demoBackend.ts               in-browser fake backend for preview   (UI)
  lib/image.ts                     resize/compress images to JPEG        (UI)
  pages/*, components/*, styles/*  UI                                    (UI)
supabase/
  migrations/0001_init.sql         tables, RLS, RPCs, storage bucket     (backend)
  functions/santa/index.ts         Edge Function (draw, recovery, reset) (backend)
  functions/_shared/crypto.ts      WebCrypto helpers, browser + Deno     (crypto)
  functions/_shared/draw.ts        draw algorithm, browser + Deno        (backend)
tests/                             vitest unit tests
docs/                              this file, SECURITY.md, SETUP.md
.github/workflows/deploy.yml       build + deploy to Pages
```

`supabase/functions/_shared/*` must use only standard web APIs (WebCrypto,
TextEncoder, atob/btoa) so the same file runs in the browser, in Deno and in
Node (vitest). The frontend imports them as `@shared/crypto.ts` /
`@shared/draw.ts` (Vite alias). Inside Deno, import with relative paths and the
`.ts` extension.

## Domain rules

- One event (row id = 1). Status `open` (joining, preferences) then `drawn`.
- Participants are configured by the admin (name list). The first visitor of a
  fresh deployment creates the admin participant ("bootstrap"); only possible
  while there are zero participants.
- First access: pick your name (unclaimed) → set password → get a recovery code.
- Later access: pick your name → password.
- Preferences (both optional, editable only while `open`):
  `noGiveTo` (I don't want to gift this person) and `noReceiveFrom`
  (I don't want this person to gift me). Cannot point to yourself.
- Draw: admin only, when every participant has claimed their name and N ≥ 4
  (with 3 people and no swaps, knowing your receiver reveals the whole draw).
  Constraints for giver g → receiver r:
  - g ≠ r
  - no swaps: never g → r and r → g together
  - r ≠ g.noGiveTo
  - g ≠ r.noReceiveFrom
  The result is drawn uniformly at random among all valid assignments
  (rejection sampling over random permutations, cryptographic RNG). If none
  exists the draw fails with a clear error and nothing is written.
- After the draw each person sees only who they gift, the budget, and that
  person's wishlist. Wishlists can be written only after the draw (the
  wishlist key is created by the draw).
- Admin can: edit event name/budget/currency/exchange date, add/rename/remove
  participants (only while `open`; remove only unclaimed), reset a person's
  account (forgot password, no recovery code), upload/delete group photos,
  draw, and reset the draw (wipes assignments and wishlists, back to `open`).
  Nothing lets the admin read assignments, preferences of others, or wishlists.

## Data model (Postgres, schema `public`)

| table | columns | who can read | who can write |
|---|---|---|---|
| `event` | `id=1`, `name`, `budget_amount numeric`, `currency text`, `exchange_date date null`, `status 'open'/'drawn'`, `drawn_at` | everyone (anon) | admin: name/budget/currency/date. status only via RPC/function |
| `participants` | `id uuid`, `name text unique`, `is_admin bool`, `user_id uuid null unique`, `kdf_salt text null`, `recovery_salt text null`, `public_key jsonb null`, `created_at` | everyone (anon) — no secrets here | admin: insert/rename/delete (open, unclaimed for delete). claim via RPC |
| `user_keys` | `participant_id pk`, `wrapped_private_key text`, `recovery_wrapped_private_key text`, `recovery_auth_hash text` | owner only | via RPC (claim, change password); service role (recovery) |
| `preferences` | `participant_id pk`, `no_give_to uuid null`, `no_receive_from uuid null` | owner only | owner, only while `open` |
| `assignments` | `giver_id pk`, `sealed text` | owner (giver) only | service role only (draw) |
| `wishlist_keys` | `participant_id pk`, `sealed text` | owner only | service role only (draw) |
| `wishlists` | `participant_id pk`, `ciphertext text`, `updated_at` | every authenticated participant (it is ciphertext) | owner only, only while `drawn` |

Storage bucket `group-photos` (private): read for authenticated, insert/delete
for admin. Client displays via signed URLs.

Auth: Supabase email/password with synthetic email `p-<participantId>@example.com`
("Confirm email" must be disabled). The Supabase password is NOT the user's
password but `authSecret` derived from it (see SECURITY.md).

### SQL helpers (security definer)

- `is_admin() returns bool`
- `my_participant_id() returns uuid`
- `bootstrap(admin_name text)` — only when `participants` is empty; anyone.
- `claim_participant(p_id, kdf_salt, recovery_salt, public_key jsonb,
  wrapped_private_key, recovery_wrapped_private_key, recovery_auth_hash)` —
  caller must be authenticated with email `p-<p_id>@example.com`, participant
  unclaimed. Sets `user_id = auth.uid()` and inserts `user_keys`.
- `update_my_keys(kdf_salt, wrapped_private_key)` — after password change.
- `reset_draw()` — admin; deletes assignments, wishlist_keys, wishlists; status → open.

### Edge Function `santa` (POST JSON `{ action, ... }`)

| action | caller | does |
|---|---|---|
| `draw` | admin JWT | validates, runs draw, seals results, writes `assignments` + `wishlist_keys`, sets status `drawn`. Never logs pairs. |
| `recover_fetch` | anyone | `{participantId, recoveryAuth}` → if `sha256(recoveryAuth) == recovery_auth_hash` returns `{recoveryWrappedPrivateKey}` |
| `recover_reset` | anyone | `{participantId, recoveryAuth, authSecret, kdfSalt, wrappedPrivateKey}` → verifies, sets auth password = authSecret, updates salt + wrapped key |
| `admin_reset_participant` | admin JWT | deletes that auth user, clears claim fields, deletes user_keys + preferences. Returns `{needsRedraw}` (true if status drawn) |

Secrets used: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (provided by Supabase
automatically), optional `ALLOWED_ORIGIN` for CORS.

## Encrypted payloads

All produced with `@shared/crypto.ts`:

- Assignment (sealed to the giver's RSA public key):
  `pad(json({v:1, receiverId, wishlistKey}), 256)`
- Wishlist key for the receiver (sealed to the receiver's public key):
  `pad(json({v:1, wishlistKey}), 256)`
- Wishlist (AES-GCM with the receiver's `wishlistKey`):
  `json({v:1, text, links, images:[{mime, dataB64}]})`. Images are resized
  in the browser to ≤ 1000 px JPEG, ≤ ~150 KB each, max 4 images.
- Clients always fetch ALL wishlist rows and decrypt only the one they hold a
  key for, so request logs don't reveal who reads which wishlist.

## Crypto module contract (`supabase/functions/_shared/crypto.ts`)

```ts
export const KDF_ITERATIONS = 600_000;
export const RECOVERY_KDF_ITERATIONS = 100_000;
export function toB64(b: Uint8Array): string;
export function fromB64(s: string): Uint8Array;
export function randomBytes(n: number): Uint8Array;
export function randomSaltB64(): string;                       // 16 bytes
export function encodeJson(v: unknown): Uint8Array;
export function decodeJson<T>(b: Uint8Array): T;
export function pad(b: Uint8Array, size: number): Uint8Array;  // 4-byte BE length prefix + data + zeros; throws if too big
export function unpad(b: Uint8Array): Uint8Array;
export function sha256Hex(s: string): Promise<string>;
export function deriveFromPassword(password: string, saltB64: string, iterations?: number):
  Promise<{ authSecret: string; kek: CryptoKey }>;             // PBKDF2-SHA256 → 512 bits: first 256 → authSecret (hex), last 256 → AES-GCM KEK (non-extractable)
export function generateRecoveryCode(): string;                // ≥128 bits, Crockford base32, groups of 4 joined by '-'
export function normalizeRecoveryCode(s: string): string;      // strip spaces/dashes, uppercase, O→0, I/L→1
export function deriveFromRecoveryCode(code: string, saltB64: string):
  Promise<{ recoveryAuth: string; kek: CryptoKey }>;          // same split as password, RECOVERY_KDF_ITERATIONS, code normalized first
export function generateUserKeyPair(): Promise<{ publicJwk: JsonWebKey; privateKey: CryptoKey }>; // RSA-OAEP 4096, SHA-256, extractable private key
export function wrapPrivateKey(privateKey: CryptoKey, kek: CryptoKey): Promise<string>;   // pkcs8 → AES-GCM, "w1.<iv>.<ct>"
export function unwrapPrivateKey(wrapped: string, kek: CryptoKey, extractable?: boolean): Promise<CryptoKey>; // throws on wrong key
export function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey>;
export function sealTo(publicKey: CryptoKey | JsonWebKey, plaintext: Uint8Array): Promise<string>; // hybrid RSA-OAEP + AES-256-GCM, "s1.<encKey>.<iv>.<ct>"
export function openSealed(privateKey: CryptoKey, sealed: string): Promise<Uint8Array>;
export function generateSymmetricKeyB64(): string;             // 32 random bytes
export function encryptWithKey(keyB64: string, plaintext: Uint8Array): Promise<string>; // "a1.<iv>.<ct>"
export function decryptWithKey(keyB64: string, ciphertext: string): Promise<Uint8Array>;
```

## Draw module contract (`supabase/functions/_shared/draw.ts`)

```ts
export interface DrawInput {
  ids: string[];
  noGiveTo: Record<string, string | null | undefined>;
  noReceiveFrom: Record<string, string | null | undefined>;
}
export class DrawImpossibleError extends Error {}
export function secureRandomInt(maxExclusive: number): number;     // crypto.getRandomValues + rejection
export function isAllowed(giver: string, receiver: string, input: DrawInput): boolean; // pairwise rules (not the swap rule)
export function isValidAssignment(a: Map<string, string>, input: DrawInput): boolean;  // full check incl. permutation + no swaps
export function hasValidAssignment(input: DrawInput): boolean;     // backtracking search
export function drawAssignment(input: DrawInput, randomInt?: (n: number) => number): Map<string, string>;
// giver → receiver. Rejection sampling (up to 2,000,000 tries) for uniformity; if it
// fails, check hasValidAssignment: impossible → DrawImpossibleError, else randomized backtracking.
```

## Frontend backend contract

See `src/api/backend.ts` and `src/types.ts`. The UI talks only to `Backend`.
`VITE_DEMO=1` (or missing Supabase config) selects `demoBackend`, which keeps
its fake "server" in `localStorage`, uses the real crypto and draw modules,
and lets you switch between people to preview every flow without Supabase.
