import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Linked implementation worktrees contain their own dependencies and tests.
    // Never discover them from the primary workspace: doing so loads a second
    // React runtime and makes the root suite report false hook failures.
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
});
