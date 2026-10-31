# Security model

## Goals

1. Each person can see only who **they** gift. Nobody — including the admin
   and anyone with access to the Supabase dashboard/database — can see who
   gifts whom, or who gifts them.
2. Wishlists are readable only by the receiver and their Secret Santa.
3. Preferences ("don't gift X", "don't receive from Y") are never shown to
   anyone else in the app.
4. Passwords are never stored or sent to the server.

## Key hierarchy

```
password ──PBKDF2-SHA256 (600k, per-user salt)──► 512 bits
                                                  ├─ authSecret (256 bits, hex) → Supabase Auth password (bcrypt-hashed by Supabase)
                                                  └─ KEK (AES-256-GCM)          → wraps the RSA private key

recovery code (≥128 bits random) ──PBKDF2 (100k, salt)──► recoveryAuth (sha256 stored server side) + recovery KEK (wraps the same private key)

RSA-OAEP 4096 key pair per person (made in the browser on first access)
  public key  → stored in participants (public)
  private key → stored only wrapped (password KEK and recovery KEK)
```

Because Supabase only ever receives `authSecret`, the server never sees the
real password and cannot derive the KEK from it.

## The draw

The draw runs in the Supabase Edge Function, not in a browser (a browser draw
would let the person who clicks it read the result in devtools). The function:

1. checks the caller is the admin, everyone has joined, status is `open`;
2. reads preferences and picks a uniformly random valid assignment using
   `crypto.getRandomValues`;
3. creates a fresh random wishlist key per receiver;
4. stores, per giver, `seal(giverPublicKey, pad({receiverId, wishlistKey}))`,
   and per receiver `seal(receiverPublicKey, pad({wishlistKey}))`;
5. returns only `{ok: true}`. It never logs or returns pairs. Plaintext exists
   only in that function's memory for a few milliseconds.

Payloads are padded to a fixed size so ciphertext length reveals nothing.

## Wishlists

Encrypted with the receiver's wishlist key (AES-256-GCM) in the browser,
images included (stored inside the encrypted row, not as separate files).
Every client downloads every wishlist row, so the request logs never show
"user X fetched wishlist Y".

## Access control (Row Level Security)

Every table has RLS enabled. Owners read their own keys, preferences,
assignment and wishlist key; nobody (not even the admin role in the app)
can read anyone else's. Assignments and wishlist keys can be written only by
the service role (the Edge Function).

## Honest limits

- **Whoever deploys the code could change it.** The admin controls the
  Supabase project and could deploy a modified function that leaks the draw.
  This system protects against peeking, not against deliberate sabotage of
  the code. The code is public in the repo so anyone can check it.
- **Preferences are protected by RLS, not encryption.** The draw function
  must read them, so they are stored in plain form in a table no app user can
  read. Someone opening the raw database in the Supabase dashboard could see
  them (but still not the assignment).
- **Weak passwords can be brute-forced offline** by someone with database
  access (600k PBKDF2 iterations make it slow). Minimum length is 10
  characters; a passphrase is recommended.
- **Forgot password and lost the recovery code = assignment lost.** The admin
  can reset that account, but then the draw has to be redone.
- **"Remember this device"** stores a non-extractable copy of the private key
  in the browser's IndexedDB. Anyone using that unlocked device could see
  that person's assignment.
- **Names are claimed on trust (no invite codes, by choice).** Anyone with the
  site link could join as a flatmate who hasn't joined yet, and the first
  visitor of a fresh deployment becomes admin. Set it up yourself first, and
  before the draw check that everyone has really joined as themselves.
- **Admin "Reset account" before the draw** lets the admin re-claim that
  person's name. The person would notice (their password stops working), but
  only at their next login. Before the draw, everyone should log in once more.
- **Wishlist links** are chosen by the receiver and seen only by their Santa,
  so a tracking link could hint who clicked. The UI says so.
- **Failed draws** (preferences make it impossible) tell the admin a little
  about combined preferences; with 12+ people this is negligible.
- **Minimum 4 people**: with 3 and no swaps, everyone could deduce the whole draw.
- Transport is HTTPS (GitHub Pages and Supabase both enforce TLS).
