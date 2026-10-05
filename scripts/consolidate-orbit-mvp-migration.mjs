import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(rootDirectory, "supabase", "migrations");
const archiveDirectory = path.join(rootDirectory, "supabase", "archive", "unapplied-0018-0032");
const destination = path.join(migrationsDirectory, "20261005124203_orbit_os_mvp_consolidation.sql");
const temporaryDestination = `${destination}.tmp`;

const sources = [
  "0018_meta_publisher.sql",
  "0019_content_item_assets_write.sql",
  "0020_publish_job_provider_fix.sql",
  "0021_meta_oauth_session_cleanup.sql",
  "0022_publish_manual_race_guard.sql",
  "0023_content_item_assets_atomic.sql",
  "0024_publish_hardening.sql",
  "0025_publication_targets_status_index.sql",
  "0026_intake_interactive_ai_usage.sql",
  "0027_organization_logos_bucket.sql",
  "0028_organization_api_keys.sql",
  "0029_actor_metadata_for_api_keys.sql",
  "0030_actor_metadata_for_multi_asset_rpc.sql",
  "0031_organization_openrouter_byok_credentials.sql",
  "0032_security_definer_grants.sql",
];

const canonicalSecurityPatch = `

-- Canonical-only corrections from the production baseline audit (2026-10-05).
-- These functions are invoked only as triggers or internal schema helpers; they
-- must never be callable through PostgREST by anon or authenticated callers.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
revoke all on function public.assign_organization_from_legacy_owner() from public, anon, authenticated;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.prevent_last_organization_owner_removal() from public, anon, authenticated;
revoke all on function public.prevent_legacy_owner_id_mutation() from public, anon, authenticated;
revoke all on function public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_owner_profile(uuid) to authenticated, service_role;

-- Avoid per-row auth.uid() re-evaluation in the only profile policy.
drop policy if exists "Users read their profile" on public.profiles;
create policy "Users read their profile" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);
`;

async function assertAbsent(target) {
  try {
    await access(target);
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

await assertAbsent(destination);
await assertAbsent(temporaryDestination);

const sourcePaths = sources.map((source) => path.join(migrationsDirectory, source));
const archivePaths = sources.map((source) => path.join(archiveDirectory, source));
for (const sourcePath of sourcePaths) await access(sourcePath);
for (const archivePath of archivePaths) await assertAbsent(archivePath);

const fragments = await Promise.all(sourcePaths.map((sourcePath) => readFile(sourcePath, "utf8")));
const canonicalSql = [
  "-- Orbit OS MVP consolidation",
  "-- Applies the final schema delta from the verified remote baseline 0001-0017.",
  "-- Source fragments are archived after this file is generated; do not apply them separately.",
  ...fragments.map((fragment, index) => `\n-- BEGIN ${sources[index]}\n${fragment.trim()}\n-- END ${sources[index]}`),
  canonicalSecurityPatch.trim(),
  "",
].join("\n");

await mkdir(archiveDirectory, { recursive: true });
await writeFile(temporaryDestination, canonicalSql, "utf8");

try {
  for (let index = 0; index < sourcePaths.length; index += 1) {
    await rename(sourcePaths[index], archivePaths[index]);
  }
  await rename(temporaryDestination, destination);
} catch (error) {
  for (let index = 0; index < sourcePaths.length; index += 1) {
    try {
      await rename(archivePaths[index], sourcePaths[index]);
    } catch (rollbackError) {
      if (rollbackError?.code !== "ENOENT") throw rollbackError;
    }
  }
  throw error;
}

console.log(`Created ${path.relative(rootDirectory, destination)} from ${sources.length} archived fragments.`);
