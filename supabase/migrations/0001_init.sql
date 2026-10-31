-- =============================================================================
-- 2 OG WEST Secret Santa 2026 — database schema, Row Level Security, RPCs and
-- storage bucket.
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--   The script is safe to re-run (tables use IF NOT EXISTS, functions use
--   CREATE OR REPLACE, policies are dropped and re-created, the event row and
--   bucket are inserted only if missing).
--
-- REQUIRED AUTH SETTING
--   Authentication → Providers (Sign In / Providers) → Email:
--     * Email provider: enabled
--     * "Confirm email": DISABLED   (accounts use synthetic addresses
--       p-<participantId>@example.com that cannot receive mail)
--   Leave "Allow new users to sign up" enabled.
--
-- SECURITY SUMMARY (see docs/SECURITY.md)
--   * RLS is enabled on every table. anon/authenticated get SELECT only where
--     needed; every write goes through a SECURITY DEFINER function below with
--     explicit checks, or through the `santa` Edge Function (service role).
--   * assignments / wishlist_keys are written only by the service role and
--     readable only by their owner. They contain ciphertext sealed to the
--     owner's public key: not even the database owner can read who gifts whom.
-- =============================================================================

-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+).

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table if not exists public.event (
  id             integer primary key default 1 check (id = 1),
  name           text not null check (name = btrim(name) and char_length(name) between 1 and 80),
  budget_amount  numeric(10, 2) not null default 0 check (budget_amount >= 0),
  currency       text not null default 'CHF' check (currency ~ '^[A-Z]{3}$'),
  exchange_date  date,
  status         text not null default 'open' check (status in ('open', 'drawn')),
  drawn_at       timestamptz,
  updated_at     timestamptz not null default now()
);

create table if not exists public.participants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  is_admin       boolean not null default false,
  user_id        uuid unique references auth.users (id) on delete set null,
  kdf_salt       text check (kdf_salt is null or char_length(kdf_salt) between 1 and 100),
  recovery_salt  text check (recovery_salt is null or char_length(recovery_salt) between 1 and 100),
  public_key     jsonb,
  created_at     timestamptz not null default now()
);

-- Names are unique case-insensitively; at most one admin.
create unique index if not exists participants_name_ci_key on public.participants (lower(name));
create unique index if not exists participants_single_admin on public.participants (is_admin) where is_admin;

create table if not exists public.user_keys (
  participant_id                uuid primary key references public.participants (id) on delete cascade,
  wrapped_private_key           text not null check (char_length(wrapped_private_key) between 1 and 20000),
  recovery_wrapped_private_key  text not null check (char_length(recovery_wrapped_private_key) between 1 and 20000),
  recovery_auth_hash            text not null check (recovery_auth_hash ~ '^[0-9a-f]{64}$'),
  updated_at                    timestamptz not null default now()
);

create table if not exists public.preferences (
  participant_id   uuid primary key references public.participants (id) on delete cascade,
  no_give_to       uuid references public.participants (id) on delete set null,
  no_receive_from  uuid references public.participants (id) on delete set null,
  updated_at       timestamptz not null default now(),
  constraint preferences_not_self_give check (no_give_to is null or no_give_to <> participant_id),
  constraint preferences_not_self_receive check (no_receive_from is null or no_receive_from <> participant_id)
);

create table if not exists public.assignments (
  giver_id    uuid primary key references public.participants (id) on delete cascade,
  sealed      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.wishlist_keys (
  participant_id  uuid primary key references public.participants (id) on delete cascade,
  sealed          text not null,
  created_at      timestamptz not null default now()
);

create table if not exists public.wishlists (
  participant_id  uuid primary key references public.participants (id) on delete cascade,
  ciphertext      text not null,
  updated_at      timestamptz not null default now()
);

insert into public.event (id, name, budget_amount, currency)
values (1, '2 OG WEST Secret Santa 2026', 10, 'CHF')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Privileges: nothing by default, then only the SELECTs that are needed.
-- -----------------------------------------------------------------------------

alter table public.event         enable row level security;
alter table public.participants  enable row level security;
alter table public.user_keys     enable row level security;
alter table public.preferences   enable row level security;
alter table public.assignments   enable row level security;
alter table public.wishlist_keys enable row level security;
alter table public.wishlists     enable row level security;

revoke all on table
  public.event, public.participants, public.user_keys, public.preferences,
  public.assignments, public.wishlist_keys, public.wishlists
from public, anon, authenticated;

grant all on table
  public.event, public.participants, public.user_keys, public.preferences,
  public.assignments, public.wishlist_keys, public.wishlists
to service_role;

grant select on table public.event, public.participants to anon, authenticated;
grant select on table public.user_keys, public.preferences, public.assignments,
                      public.wishlist_keys, public.wishlists to authenticated;

-- -----------------------------------------------------------------------------
-- Helper functions (used by policies, so they are created before them)
-- -----------------------------------------------------------------------------

create or replace function public.my_participant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id from public.participants p where p.user_id = auth.uid() and auth.uid() is not null limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.participants p
    where p.user_id = auth.uid() and auth.uid() is not null and p.is_admin
  );
$$;

-- Internal helpers (not callable by clients).
create or replace function public._require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select p.id into v_id from public.participants p
  where p.user_id = auth.uid() and auth.uid() is not null and p.is_admin;
  if v_id is null then
    raise exception 'Only the admin can do this.' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

create or replace function public._require_me()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid := public.my_participant_id();
begin
  if v_id is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

create or replace function public._clean_name(p_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v) < 1 then
    raise exception 'Please enter a name.' using errcode = '22023';
  end if;
  if char_length(v) > 40 then
    raise exception 'Names can be at most 40 characters.' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Current event status, locking the event row (FOR SHARE) until the end of the
-- transaction so status changes and the guarded write cannot interleave.
create or replace function public._event_status_locked()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select e.status into v_status from public.event e where e.id = 1 for share;
  if v_status is null then
    raise exception 'The event is not set up. Run the database migration again.' using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security policies (reads only; there are no write policies)
-- -----------------------------------------------------------------------------

drop policy if exists event_read on public.event;
create policy event_read on public.event
  for select to anon, authenticated using (true);

drop policy if exists participants_read on public.participants;
create policy participants_read on public.participants
  for select to anon, authenticated using (true);

drop policy if exists user_keys_read_own on public.user_keys;
create policy user_keys_read_own on public.user_keys
  for select to authenticated using (participant_id = public.my_participant_id());

drop policy if exists preferences_read_own on public.preferences;
create policy preferences_read_own on public.preferences
  for select to authenticated using (participant_id = public.my_participant_id());

drop policy if exists assignments_read_own on public.assignments;
create policy assignments_read_own on public.assignments
  for select to authenticated using (giver_id = public.my_participant_id());

drop policy if exists wishlist_keys_read_own on public.wishlist_keys;
create policy wishlist_keys_read_own on public.wishlist_keys
  for select to authenticated using (participant_id = public.my_participant_id());

-- All rows (ciphertext) for any signed-in participant: clients always fetch
-- every row so logs don't reveal whose wishlist someone reads.
drop policy if exists wishlists_read_all on public.wishlists;
create policy wishlists_read_all on public.wishlists
  for select to authenticated using (public.my_participant_id() is not null);

-- -----------------------------------------------------------------------------
-- RPCs (all writes)
-- -----------------------------------------------------------------------------

-- Fresh deployment: the first visitor creates the admin participant.
create or replace function public.bootstrap(admin_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name text := public._clean_name(admin_name);
  v_id uuid;
begin
  -- Serialize concurrent bootstrap attempts.
  lock table public.participants in share row exclusive mode;
  if exists (select 1 from public.participants) then
    raise exception 'This Secret Santa has already been set up.' using errcode = '42501';
  end if;
  insert into public.participants (name, is_admin) values (v_name, true) returning id into v_id;
  return v_id;
end;
$$;

-- First access: link the signed-up auth user to an unclaimed participant.
create or replace function public.claim_participant(
  p_id uuid,
  p_kdf_salt text,
  p_recovery_salt text,
  p_public_key jsonb,
  p_wrapped_private_key text,
  p_recovery_wrapped_private_key text,
  p_recovery_auth_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_user_id uuid;
  v_found boolean;
begin
  if v_uid is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'Unknown participant.' using errcode = '22023';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email <> ('p-' || p_id::text || '@example.com') then
    raise exception 'This account does not belong to that name.' using errcode = '42501';
  end if;

  if exists (select 1 from public.participants p where p.user_id = v_uid) then
    raise exception 'This account is already linked to a name.' using errcode = '42501';
  end if;

  select true, p.user_id into v_found, v_user_id
  from public.participants p where p.id = p_id for update;
  if v_found is null then
    raise exception 'Unknown participant.' using errcode = '22023';
  end if;
  if v_user_id is not null then
    raise exception 'This name has already been claimed.' using errcode = '42501';
  end if;

  if p_kdf_salt is null or char_length(p_kdf_salt) not between 1 and 100
     or p_recovery_salt is null or char_length(p_recovery_salt) not between 1 and 100 then
    raise exception 'Invalid key data.' using errcode = '22023';
  end if;
  if p_public_key is null or jsonb_typeof(p_public_key) <> 'object'
     or p_public_key ->> 'kty' is distinct from 'RSA'
     or coalesce(p_public_key ->> 'n', '') = '' or coalesce(p_public_key ->> 'e', '') = ''
     or p_public_key ? 'd'  -- never accept a private key here
     or octet_length(p_public_key::text) > 5000 then
    raise exception 'Invalid public key.' using errcode = '22023';
  end if;
  if p_wrapped_private_key is null or char_length(p_wrapped_private_key) not between 1 and 20000
     or p_recovery_wrapped_private_key is null or char_length(p_recovery_wrapped_private_key) not between 1 and 20000
     or p_recovery_auth_hash is null or p_recovery_auth_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid key data.' using errcode = '22023';
  end if;

  update public.participants
     set user_id = v_uid,
         kdf_salt = p_kdf_salt,
         recovery_salt = p_recovery_salt,
         public_key = p_public_key
   where id = p_id;

  insert into public.user_keys (participant_id, wrapped_private_key, recovery_wrapped_private_key, recovery_auth_hash, updated_at)
  values (p_id, p_wrapped_private_key, p_recovery_wrapped_private_key, p_recovery_auth_hash, now())
  on conflict (participant_id) do update
     set wrapped_private_key = excluded.wrapped_private_key,
         recovery_wrapped_private_key = excluded.recovery_wrapped_private_key,
         recovery_auth_hash = excluded.recovery_auth_hash,
         updated_at = now();
end;
$$;

-- After a password change (the client re-wraps the private key).
create or replace function public.update_my_keys(p_kdf_salt text, p_wrapped_private_key text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := public._require_me();
begin
  if p_kdf_salt is null or char_length(p_kdf_salt) not between 1 and 100
     or p_wrapped_private_key is null or char_length(p_wrapped_private_key) not between 1 and 20000 then
    raise exception 'Invalid key data.' using errcode = '22023';
  end if;
  update public.participants set kdf_salt = p_kdf_salt where id = v_me;
  update public.user_keys set wrapped_private_key = p_wrapped_private_key, updated_at = now()
   where participant_id = v_me;
  if not found then
    raise exception 'Your account keys are missing. Ask the admin to reset your account.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.set_my_preferences(p_no_give_to uuid, p_no_receive_from uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := public._require_me();
begin
  if public._event_status_locked() <> 'open' then
    raise exception 'Preferences can no longer be changed after the draw.' using errcode = '42501';
  end if;
  if p_no_give_to = v_me or p_no_receive_from = v_me then
    raise exception 'You cannot pick yourself.' using errcode = '22023';
  end if;
  if p_no_give_to is not null and not exists (select 1 from public.participants where id = p_no_give_to) then
    raise exception 'Unknown participant.' using errcode = '22023';
  end if;
  if p_no_receive_from is not null and not exists (select 1 from public.participants where id = p_no_receive_from) then
    raise exception 'Unknown participant.' using errcode = '22023';
  end if;

  insert into public.preferences (participant_id, no_give_to, no_receive_from, updated_at)
  values (v_me, p_no_give_to, p_no_receive_from, now())
  on conflict (participant_id) do update
     set no_give_to = excluded.no_give_to,
         no_receive_from = excluded.no_receive_from,
         updated_at = now();
end;
$$;

create or replace function public.save_my_wishlist(p_ciphertext text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := public._require_me();
begin
  if public._event_status_locked() <> 'drawn' then
    raise exception 'Wishlists can be written after the draw.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.wishlist_keys k where k.participant_id = v_me) then
    raise exception 'Wishlists can be written after the draw.' using errcode = '42501';
  end if;
  if p_ciphertext is null or char_length(p_ciphertext) < 1 then
    raise exception 'Empty wishlist.' using errcode = '22023';
  end if;
  if octet_length(p_ciphertext) > 3 * 1024 * 1024 then
    raise exception 'Your wishlist is too large. Remove an image or two and try again.' using errcode = '22023';
  end if;

  insert into public.wishlists (participant_id, ciphertext, updated_at)
  values (v_me, p_ciphertext, now())
  on conflict (participant_id) do update
     set ciphertext = excluded.ciphertext,
         updated_at = now();
end;
$$;

create or replace function public.admin_update_event(
  p_name text,
  p_budget_amount numeric,
  p_currency text,
  p_exchange_date date
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
begin
  perform public._require_admin();
  if char_length(v_name) not between 1 and 80 then
    raise exception 'The event name must be 1 to 80 characters.' using errcode = '22023';
  end if;
  if p_budget_amount is null or p_budget_amount < 0 or p_budget_amount > 99999999 then
    raise exception 'The budget must be zero or more.' using errcode = '22023';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'The currency must be a 3-letter code like CHF or EUR.' using errcode = '22023';
  end if;

  update public.event
     set name = v_name,
         budget_amount = round(p_budget_amount, 2),
         currency = v_currency,
         exchange_date = p_exchange_date,
         updated_at = now()
   where id = 1;
end;
$$;

create or replace function public.admin_add_participant(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name text;
  v_id uuid;
begin
  perform public._require_admin();
  v_name := public._clean_name(p_name);
  if public._event_status_locked() <> 'open' then
    raise exception 'People can only be added before the draw. Reset the draw first.' using errcode = '42501';
  end if;
  begin
    insert into public.participants (name) values (v_name) returning id into v_id;
  exception when unique_violation then
    raise exception 'Someone with that name already exists.' using errcode = '23505';
  end;
  return v_id;
end;
$$;

create or replace function public.admin_rename_participant(p_id uuid, p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  perform public._require_admin();
  v_name := public._clean_name(p_name);
  if public._event_status_locked() <> 'open' then
    raise exception 'Names can only be changed before the draw.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.participants p where p.id = p_id) then
    raise exception 'Unknown participant.' using errcode = 'P0002';
  end if;
  begin
    update public.participants set name = v_name where id = p_id;
  exception when unique_violation then
    raise exception 'Someone with that name already exists.' using errcode = '23505';
  end;
end;
$$;

create or replace function public.admin_remove_participant(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_is_admin boolean;
begin
  perform public._require_admin();
  if public._event_status_locked() <> 'open' then
    raise exception 'People can only be removed before the draw.' using errcode = '42501';
  end if;
  select p.user_id, p.is_admin into v_user_id, v_is_admin
  from public.participants p where p.id = p_id for update;
  if v_is_admin is null then
    raise exception 'Unknown participant.' using errcode = 'P0002';
  end if;
  if v_is_admin then
    raise exception 'The admin cannot be removed.' using errcode = '42501';
  end if;
  if v_user_id is not null then
    raise exception 'This person has already joined. Reset their account first if you really want to remove them.' using errcode = '42501';
  end if;
  delete from public.participants where id = p_id;
end;
$$;

create or replace function public.reset_draw()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._require_admin();
  perform 1 from public.event e where e.id = 1 for update;
  delete from public.assignments where true;
  delete from public.wishlist_keys where true;
  delete from public.wishlists where true;
  update public.event set status = 'open', drawn_at = null, updated_at = now() where id = 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges: nobody by default, then only who needs it.
-- (Supabase grants EXECUTE to anon/authenticated by default, so revoke those too.)
-- -----------------------------------------------------------------------------

revoke all on function public.my_participant_id() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public._require_admin() from public, anon, authenticated;
revoke all on function public._require_me() from public, anon, authenticated;
revoke all on function public._clean_name(text) from public, anon, authenticated;
revoke all on function public._event_status_locked() from public, anon, authenticated;
revoke all on function public.bootstrap(text) from public, anon, authenticated;
revoke all on function public.claim_participant(uuid, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.update_my_keys(text, text) from public, anon, authenticated;
revoke all on function public.set_my_preferences(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_my_wishlist(text) from public, anon, authenticated;
revoke all on function public.admin_update_event(text, numeric, text, date) from public, anon, authenticated;
revoke all on function public.admin_add_participant(text) from public, anon, authenticated;
revoke all on function public.admin_rename_participant(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_remove_participant(uuid) from public, anon, authenticated;
revoke all on function public.reset_draw() from public, anon, authenticated;

-- Used by RLS / storage policies and by the client.
grant execute on function public.my_participant_id() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;

-- Fresh deployment, before anyone has an account.
grant execute on function public.bootstrap(text) to anon, authenticated;

-- Signed-in users (each function checks who the caller is).
grant execute on function public.claim_participant(uuid, text, text, jsonb, text, text, text) to authenticated;
grant execute on function public.update_my_keys(text, text) to authenticated;
grant execute on function public.set_my_preferences(uuid, uuid) to authenticated;
grant execute on function public.save_my_wishlist(text) to authenticated;
grant execute on function public.admin_update_event(text, numeric, text, date) to authenticated;
grant execute on function public.admin_add_participant(text) to authenticated;
grant execute on function public.admin_rename_participant(uuid, text) to authenticated;
grant execute on function public.admin_remove_participant(uuid) to authenticated;
grant execute on function public.reset_draw() to authenticated;

-- -----------------------------------------------------------------------------
-- Storage: private bucket for group photos
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('group-photos', 'group-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

drop policy if exists group_photos_read on storage.objects;
create policy group_photos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'group-photos' and public.my_participant_id() is not null);

drop policy if exists group_photos_insert_admin on storage.objects;
create policy group_photos_insert_admin on storage.objects
  for insert to authenticated
  with check (bucket_id = 'group-photos' and public.is_admin());

drop policy if exists group_photos_delete_admin on storage.objects;
create policy group_photos_delete_admin on storage.objects
  for delete to authenticated
  using (bucket_id = 'group-photos' and public.is_admin());
