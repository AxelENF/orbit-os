import { access, readFile } from "node:fs/promises";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET",
];

function statusOf(value) {
  if (!value?.trim()) return "missing";
  if (/your-|replace-with|example\.com/i.test(value)) return "placeholder";
  return "configured";
}

let envText = "";
try {
  await access(envPath);
  envText = await readFile(envPath, "utf8");
} catch {
  console.log("Orbit OS local readiness\n");
  console.log("Mode: demo (no .env.local found; no remote service will be called).");
  console.log("Next: copy .env.example to .env.local and configure server-only values outside Git.");
  process.exit(0);
}

const values = new Map();
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}

console.log("Orbit OS local readiness\n");
for (const name of required) console.log(`${name}: ${statusOf(values.get(name))}`);

const missing = required.filter((name) => statusOf(values.get(name)) !== "configured");
const metaEnabled = values.get("SNAPGAD_META_PUBLISH_WORKER_ENABLED") === "true";
const n8nEnabled = values.get("SNAPGAD_N8N_PUBLISH_ENABLED") === "true";

console.log(`\nPublish controls: Meta=${metaEnabled ? "enabled" : "disabled"}, n8n=${n8nEnabled ? "enabled" : "disabled"}`);
if (missing.length) {
  console.log("Result: configuration incomplete; portal must stay in demo/safe-failure mode.");
  console.log(`Missing or placeholders: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Result: Supabase runtime variables are present. Start npm run dev, then complete the authenticated smoke test.");
}
