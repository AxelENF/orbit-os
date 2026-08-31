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
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. These values
  allow the browser and server to construct anon-key clients only when present.
  The service-role key is intentionally not included or exposed to the browser.

The database schema has not been applied by this repository. When a Supabase
project is ready, review `supabase/migrations/0001_content_os.sql` and apply it
with the Supabase CLI or SQL editor in the intended environment. The migration
creates a private `content-assets` storage bucket and owner-only RLS policies.
