import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0014_copy_hashtags_and_ai_usage.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("copy hashtags and AI usage migration", () => {
  it("adds a bounded hashtags column to copy_drafts", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.copy_drafts/i);
    expect(sql).toMatch(/add column hashtags jsonb not null default '\[\]'::jsonb/i);
    expect(sql).toMatch(/jsonb_array_length\(p_hashtags\)\s*<=\s*8/i);
    expect(sql).toMatch(/create function public\.are_valid_hashtags/i);
    expect(sql).toMatch(/tag !~ '\^#\[\[:alnum:\]_\]\+\$'/i);
  });

  it("extends ingest_copy_result_callback to accept and validate hashtags", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create or replace function public\.ingest_copy_result_callback/i);
    expect(sql).toMatch(/coalesce\(item\.draft -> 'hashtags', '\[\]'::jsonb\)/i);
    expect(sql).toMatch(/not public\.are_valid_hashtags\(coalesce\(item\.draft -> 'hashtags'/i);
  });

  it("creates an append-only ai_usage_events ledger scoped by organization", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table public\.ai_usage_events/i);
    expect(sql).toMatch(/organization_id uuid not null references public\.organizations/i);
    expect(sql).toMatch(/estimated_cost_usd numeric/i);
    expect(sql).toMatch(/is_organization_member\(organization_id\)/i);
  });

  it("adds an optional monthly AI budget cap to organizations", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organizations/i);
    expect(sql).toMatch(/add column ai_monthly_budget_usd numeric/i);
  });

  it("extends fail_copy_automation_job to transition content on terminal failure", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create or replace function public\.fail_copy_automation_job/i);
    expect(sql).toMatch(/next_status in \('FAILED', 'DEAD_LETTER'\)/i);
    expect(sql).toMatch(/set state = 'ERROR'::public\.content_state/i);
    expect(sql).toMatch(/'COPY_JOB_FAILED'/i);
  });

  it("adds hashtags to the immutable final copy record", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.final_copy_versions/i);
    expect(sql).toMatch(/add column hashtags jsonb not null default '\[\]'::jsonb/i);
    expect(sql).toMatch(/p_hashtags jsonb/i);
  });

  it("drops the 8-parameter submit_final_copy_for_review instead of creating a coexisting overload", async () => {
    const sql = await readMigration();
    // Adding a parameter via create-or-replace creates a second overload
    // instead of replacing the function, and Postgres grants PUBLIC execute
    // on newly created functions by default — an easy way to accidentally
    // expose a service_role-only RPC to any authenticated caller. Guard
    // against reintroducing that pattern.
    expect(sql).toMatch(
      /drop function if exists public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.submit_final_copy_for_review/i);
    expect(sql).toMatch(/create function public\.submit_final_copy_for_review/i);
  });

  it("restricts the new submit_final_copy_for_review overload to service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /revoke all on function public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text, jsonb\s*\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text, jsonb\s*\)[\s\S]*to service_role/i,
    );
  });
});

describe("AI usage reservation migration", () => {
  it("adds an additive, worker-only atomic reservation contract", async () => {
    const path = fileURLToPath(
      new URL("../../supabase/migrations/0015_ai_usage_reservations.sql", import.meta.url),
    );
    const sql = await readFile(path, "utf8");

    expect(sql).toMatch(/create table public\.ai_usage_reservations/i);
    expect(sql).toMatch(/unique \(job_id, attempt\)/i);
    expect(sql).toMatch(/create (or replace )?function public\.reserve_ai_request_budget/i);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/create (or replace )?function public\.settle_ai_usage_reservation/i);
    expect(sql).toMatch(/grant execute on function public\.reserve_ai_request_budget[\s\S]*to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.settle_ai_usage_reservation[\s\S]*to service_role/i);
  });
});
