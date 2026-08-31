# SnapGad Content OS

This project starts in demo mode. It does not require external service credentials
and uses an isolated in-memory repository, so it never calls Supabase, n8n, Meta,
or any other service.

Do not commit Supabase, Meta, n8n, or any other real credentials. Use local environment files for future configuration and keep them out of version control.

## Setup

```bash
npm install
npm test
npm run lint
```

## Modes

- **Demo (default):** leave the Supabase variables unset. The app uses the
  in-memory repository for local development and tests only.
- **Configured Supabase (later):** copy `.env.example` to `.env.local` and set
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the
  server-only `SUPABASE_SERVICE_ROLE_KEY`. The selector stays in demo mode
  until all three are present. The service-role key is never imported into or
  exposed to the browser.

The database schema has not been applied by this repository. When a Supabase
project is ready, review `supabase/migrations/0001_content_os.sql` and apply it
with the Supabase CLI or SQL editor in the intended environment. The migration
creates a private `content-assets` storage bucket and owner-only RLS policies.
Live RLS/migration verification remains pending until staging credentials exist.

Audit events are immutable. Their related profile, content item, and publication
target references use `RESTRICT`, so those records cannot be deleted while an
audit event depends on them.

## Initial owner bootstrap

The migration creates and backfills profiles as `reviewer`, and clients cannot
change roles. After identifying the intended user's Auth UUID, an operator with
server/database access promotes that UUID to `owner` in `public.profiles`.
Do this through a reviewed, privileged runbook; never from the browser and never
by hardcoding an email in a migration. Only an `owner` profile can invoke the
protected content-creation RPC.

```sql
-- Run only through a privileged operator session after verifying this Auth UUID.
update public.profiles
set role = 'owner'
where id = '<auth-user-uuid>';
```

Automation idempotency is scoped to `(kind, idempotency_key)`: a copy or
publish request and its callback can share one logical key, while a duplicate
of the same kind is rejected.
