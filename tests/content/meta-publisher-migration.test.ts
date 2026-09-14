import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0018_meta_publisher.sql", import.meta.url));
  return readFile(path, "utf8");
}

async function readProviderFixMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0020_publish_job_provider_fix.sql", import.meta.url));
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("content_item_assets", () => {
  it("declara la tabla con position acotada entre 0 y 9", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table public\.content_item_assets/i);
    expect(sql).toMatch(/position smallint not null check \(position >= 0 and position <= 9\)/i);
  });

  it("declara unique\\(content_item_id, position\\) y unique\\(content_item_id, asset_id\\)", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/unique \(content_item_id, position\)/i);
    expect(sql).toMatch(/unique \(content_item_id, asset_id\)/i);
  });

  it("declara FKs compuestas por (content_item_id/asset_id, organization_id) para evitar mezclar tenants", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/foreign key \(content_item_id, organization_id\)\s*references public\.content_items \(id, organization_id\)/i);
    expect(sql).toMatch(/foreign key \(asset_id, organization_id\)\s*references public\.assets \(id, organization_id\)/i);
  });

  it("incluye el backfill de position=0 para content_items con asset_id existente", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/insert into public\.content_item_assets \(organization_id, content_item_id, asset_id, position\)/i);
    expect(sql).toMatch(/where asset_id is not null/i);
  });

  it("habilita RLS sin policy de escritura para authenticated", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.content_item_assets enable row level security/i);
  });
});

describe("organization_meta_connections", () => {
  it("habilita RLS y revoca el acceso directo a la tabla para authenticated/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organization_meta_connections enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.organization_meta_connections from public, anon, authenticated/i);
    // Nota: no se agrega un `not.toMatch` genérico de "no existe ninguna
    // policy" — con [\s\S]* eso hace match voraz contra CUALQUIER policy de
    // cualquier otra tabla en el mismo archivo y da falsos positivos/negativos
    // (hallazgo de revisión Codex ronda 2). Las dos aserciones positivas de
    // arriba ya cubren el contrato real.
  });

  it("get_meta_connection_status no selecciona ni regresa page_access_token", async () => {
    const sql = await readMigration();
    const fnMatch = sql.match(/create function public\.get_meta_connection_status[\s\S]*?\$\$;/i);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/page_access_token/i);
  });

  it("get_meta_connection_status se otorga a authenticated; upsert/revoke/mark-error solo a service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/grant execute on function public\.get_meta_connection_status\(uuid, uuid\) to authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.upsert_meta_connection\([^)]*\) to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.revoke_meta_connection\(uuid\) to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.mark_meta_connection_error\(uuid\) to service_role/i);
  });

  it("el CHECK de page_access_token no exige texto no-vacío cuando status no es ACTIVE (para que revoke pueda limpiarlo)", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/check \(status <> 'ACTIVE' or length\(btrim\(page_access_token\)\) > 0\)/i);
  });
});

describe("organization_meta_oauth_sessions", () => {
  it("revoca el acceso directo a authenticated/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organization_meta_oauth_sessions enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.organization_meta_oauth_sessions from public, anon, authenticated/i);
  });

  it("discovered_pages exige un array jsonb", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/discovered_pages jsonb not null check \(jsonb_typeof\(discovered_pages\) = 'array'\)/i);
  });
});

describe("automation_jobs PUBLISH kind", () => {
  it("dropea el check viejo automation_jobs_kind_check antes de agregar el nuevo", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.automation_jobs drop constraint if exists automation_jobs_kind_check/i);
    expect(sql).toMatch(/add constraint automation_jobs_kind_check check \(kind in \('COPY', 'PUBLISH'\)\)/i);
  });

  it("publication_target_id es obligatorio solo para kind='PUBLISH'", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/add column publication_target_id uuid references public\.publication_targets\(id\)/i);
    expect(sql).toMatch(/\(kind = 'COPY' and publication_target_id is null\)/i);
    expect(sql).toMatch(/\(kind = 'PUBLISH' and publication_target_id is not null\)/i);
  });
});

describe("PUBLISH job lifecycle SQL", () => {
  it("enqueue_publish_automation_job deriva la idempotency key con md5(...)::uuid, no gen_random_uuid", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.enqueue_publish_automation_job[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/md5\(p_publication_target_id::text\)::uuid/i);
  });
  it("claim_next_publish_automation_job bloquea la fila del target (for update) antes de decidir si lo reclama, para serializar dos claims concurrentes del mismo target", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.claim_next_publish_automation_job[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/select \* into target\s+from public\.publication_targets\s+where id = job\.publication_target_id and organization_id = job\.organization_id\s+for update/i);
  });
  it("claim_next_publish_automation_job re-verifica jobs PROCESSING concurrentes para el mismo target DESPUÉS de bloquear el target, no antes", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.claim_next_publish_automation_job[\s\S]*?\$\$;/i)![0];
    const targetLockIndex = fn.search(/for update;[\s\S]*?if target\.status/i);
    const concurrentCheckIndex = fn.search(/active\.status = 'PROCESSING'/i);
    expect(targetLockIndex).toBeGreaterThan(-1);
    expect(concurrentCheckIndex).toBeGreaterThan(targetLockIndex);
  });
  it("claim_next_publish_automation_job llama fail_claim_publish_job (que pone el target en ERROR, no solo el job) en cada rama de falla temprana genuina", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.claim_next_publish_automation_job[\s\S]*?\$\$;/i)![0];
    const failCalls = fn.match(/perform public\.fail_claim_publish_job/gi) ?? [];
    // target no encontrado, target no APPROVED (tras descartar PUBLISHED),
    // sin conexión, IG no conectado, sin copy final, sin assets.
    expect(failCalls.length).toBe(6);
  });
  it("un target ya PUBLISHED con un job duplicado obsoleto se cancela el job SIN llamar fail_claim_publish_job (no sobrescribe el estado bueno con ERROR)", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.claim_next_publish_automation_job[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/if target\.status = 'PUBLISHED' then/i);
    expect(fn).toMatch(/'PUBLISH_JOB_TARGET_ALREADY_PUBLISHED'/i);
  });
  it("recover_expired_publish_automation_jobs pone en ERROR los targets de los jobs que terminan en DEAD_LETTER", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.recover_expired_publish_automation_jobs[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/'ERROR'::public\.publication_status/i);
  });
  it("fail_publish_automation_job audita PUBLISH_JOB_FAILED y marca ERROR solo en transición terminal", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.fail_publish_automation_job[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/'PUBLISH_JOB_FAILED'/i);
    expect(fn).toMatch(/next_status in \('FAILED', 'DEAD_LETTER'\)/i);
  });
  it("fail_publish_automation_job con p_requires_reconnect llama mark_meta_connection_error", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.fail_publish_automation_job[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/if p_requires_reconnect then/i);
    expect(fn).toMatch(/perform public\.mark_meta_connection_error/i);
  });
  it("las seis funciones están revocadas de public/anon/authenticated y otorgadas solo a service_role", async () => {
    const sql = await readMigration();
    for (const name of [
      "enqueue_publish_automation_job", "claim_next_publish_automation_job", "renew_publish_automation_job",
      "complete_publish_automation_job", "fail_publish_automation_job", "cancel_publish_automation_job",
      "recover_expired_publish_automation_jobs", "summarize_publish_automation_jobs",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`, "i"));
    }
  });
});

describe("0020 publish job provider fix", () => {
  it("inserta provider='meta' en los jobs creados por enqueue y retry", async () => {
    const sql = await readProviderFixMigration();

    for (const functionName of ["enqueue_publish_automation_job", "retry_publish_target"]) {
      const functionMatch = sql.match(
        new RegExp(`create (?:or replace )?function public\\.${functionName}[\\s\\S]*?\\$\\$;`, "i"),
      );
      expect(functionMatch).not.toBeNull();
      expect(functionMatch?.[0]).toMatch(
        /insert into public\.automation_jobs\s*\([^)]*\bprovider\b[^)]*\)\s*values\s*\([^;]*'meta'/is,
      );
    }
  });
});

describe("0020 retry target content validation", () => {
  it("valida content_item_id en el lock inicial y elimina el overload anterior", async () => {
    const sql = await readProviderFixMigration();
    const functionMatch = sql.match(
      /create (?:or replace )?function public\.retry_publish_target[\s\S]*?\$\$;/i,
    );

    expect(sql).toMatch(/drop function if exists public\.retry_publish_target\(uuid, uuid, uuid\)/i);
    expect(functionMatch).not.toBeNull();
    expect(functionMatch?.[0]).toMatch(/p_content_item_id uuid/i);
    expect(functionMatch?.[0]).toMatch(
      /select \* into target[\s\S]*?where\s+id = p_publication_target_id\s+and organization_id = p_organization_id\s+and content_item_id = p_content_item_id\s+for update/i,
    );
  });
});

describe("apply_publication_diagnosis SQL", () => {
  it("automation_runs.kind se extiende para aceptar PUBLISH_DIAGNOSIS", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.automation_runs drop constraint if exists automation_runs_kind_check/i);
    expect(sql).toMatch(/'PUBLISH_DIAGNOSIS'/i);
  });
  it("is_safe exige quality_level='promising' Y que TODOS los findings tengan severity='info' (fail-closed ante severity nula/desconocida)", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.apply_publication_diagnosis[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/coalesce\(finding->>'severity', ''\) <> 'info'/i);
  });
  it("bloquea con lock en content_items antes que en publication_targets (mismo orden que approve_publication_target)", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.apply_publication_diagnosis[\s\S]*?\$\$;/i)![0];
    const itemLockIndex = fn.search(/select \* into item from public\.content_items[\s\S]*?for update/i);
    const targetUpdateIndex = fn.search(/update public\.publication_targets set status = 'APPROVED'/i);
    expect(itemLockIndex).toBeGreaterThan(-1);
    expect(targetUpdateIndex).toBeGreaterThan(itemLockIndex);
  });
});

describe("approve_publication_target fixes (regex sobre la migración)", () => {
  it("encola el job PUBLISH tanto en el camino de retorno anticipado como en el de recién-aprobado", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create or replace function public\.approve_publication_target[\s\S]*?\$\$;/i)![0];
    const calls = fn.match(/perform public\.enqueue_publish_automation_job/gi) ?? [];
    expect(calls.length).toBe(2);
  });
  it("el conteo de pendientes excluye APPROVED y PUBLISHED, no solo APPROVED", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create or replace function public\.approve_publication_target[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/status not in \('APPROVED', 'PUBLISHED'\)/i);
  });
});

describe("retry_publish_target (regex sobre la migración)", () => {
  it("exige status='ERROR' y usa gen_random_uuid (no una key determinística) para el reintento", async () => {
    const sql = await readMigration();
    const fn = sql.match(/create function public\.retry_publish_target[\s\S]*?\$\$;/i)![0];
    expect(fn).toMatch(/if target\.status <> 'ERROR' then/i);
    expect(fn).toMatch(/'PUBLISH', 'QUEUED', gen_random_uuid\(\)/i);
  });
});
