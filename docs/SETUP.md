# Setup guide

About 20 minutes, all free. You need a GitHub account and a Supabase account.

## 0. Try it locally first (optional, no accounts)

```bash
npm install
npm run dev:demo
```

Open the printed URL. Demo mode keeps a fake server in your browser. Use
"Demo tools" to add example flatmates and switch between people.

## 1. Supabase project

1. Go to https://supabase.com → New project (any name, e.g. `secret-santa`,
   region close to you, strong DB password — you won't need it in the app).
2. **Authentication → Sign In / Providers → Email**: keep Email enabled,
   turn **off "Confirm email"** and **off "Secure password change"**, and
   keep **"Allow new users to sign up"** on. (Accounts use internal
   addresses; no emails are ever sent.)
3. **SQL Editor → New query**: paste the whole content of
   `supabase/migrations/0001_init.sql` and run it.
4. **Project Settings → API**: copy the **Project URL** and the **anon public**
   key. Both are public by design — the database rules (RLS) decide what the
   anon key can do. Never copy the `service_role` key anywhere.

## 2. Deploy the Edge Function

Requires Node (already installed). From this folder:

```bash
npx supabase login
```

```bash
npx supabase functions deploy santa --project-ref YOUR-PROJECT-REF
```

`YOUR-PROJECT-REF` is the part before `.supabase.co` in the Project URL.
If your project shows the newer `sb_publishable_...` key instead of the
legacy anon JWT key, add `--no-verify-jwt` (the function checks callers itself).
Optionally restrict CORS to your site:

```bash
npx supabase secrets set ALLOWED_ORIGIN=https://YOUR-GITHUB-USER.github.io --project-ref YOUR-PROJECT-REF
```

## 3. GitHub Pages

1. Create a new **public** repository (e.g. `2-og-west-secret-santa`) and push
   this folder to its `main` branch.
2. **Settings → Secrets and variables → Actions → Variables**: add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the values from step 1.4.
3. **Settings → Pages → Source: GitHub Actions**.
4. Push (or re-run the "Deploy to GitHub Pages" workflow). The site appears at
   `https://YOUR-GITHUB-USER.github.io/2-og-west-secret-santa/`.

## 4. First run

1. Open the site yourself first: you'll see "Set up your Secret Santa". Enter
   your name — you become the admin — then set your password and save the
   recovery code.
2. Admin page: set budget/currency/date, add all flatmates' names, upload
   group photos.
3. Share the link. Everyone picks their name, sets a password, saves their
   recovery code and optionally sets their two preferences.
4. When everyone has joined, press **Draw names**.

## Wiping everything (after testing, or to start over)

Supabase → SQL Editor → run:

```sql
delete from public.wishlists;
delete from public.wishlist_keys;
delete from public.assignments;
delete from public.preferences;
delete from public.user_keys;
delete from public.participants;
update public.event set status = 'open', drawn_at = null where id = 1;
delete from auth.users where email like 'p-%@example.com';
```

Group photos are in Storage → `group-photos`; delete them there if needed.
The site then shows "Set up your Secret Santa" again.

## Troubleshooting

- "Confirm email is enabled" error on join → step 1.2.
- Draw says it's impossible → preferences block every valid combination;
  ask people to relax them (they can change them before the draw).
- Someone forgot the password: they use "Forgot password?" with their
  recovery code. Without the code: Admin → Reset account, they rejoin, and
  you have to reset and redo the draw.
