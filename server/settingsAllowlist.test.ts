/**
 * Guard for a documented, recurring bug class in this repo:
 *
 *   "settings.save's zod allowlist must include any new workspace_settings
 *    column or saves silently drop it."
 *
 * The failure is nasty because it is SILENT AND LOOKS LIKE SUCCESS: zod strips
 * the unknown key, the patch comes out empty, the mutation still returns
 * {ok:true}, the UI shows a success toast — and the setting reverts on reload.
 * It cost `nightlyPipelineEnabled` / `nightlyScoreThreshold` entirely: the AI
 * Nightly Pipeline toggle could never be switched on, even though the cron
 * that consumes it (nightlyBatch.ts) was fully implemented.
 *
 * This test reads the two files as source text and asserts that every key the
 * Settings page passes to `settings.save({...})` is present in the mutation's
 * input schema. It is deliberately a source-level check: the input schema
 * isn't exported, and the point is to catch the mismatch at the boundary where
 * it actually happens.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

/** Extract the body of every `save({ ... })` call, brace-matched so that
 *  nested objects and multi-line calls are handled correctly. */
function extractSaveCallBodies(src: string): string[] {
  const bodies: string[] = [];
  const marker = "save({";
  let idx = src.indexOf(marker);
  while (idx !== -1) {
    let depth = 0;
    let i = idx + marker.length - 1; // position of the '{'
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < src.length) bodies.push(src.slice(start, i));
    idx = src.indexOf(marker, idx + marker.length);
  }
  return bodies;
}

/** Top-level `key:` names within one object literal body. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let line = "";
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      keys.push(line);
      line = "";
    } else line += ch;
  }
  keys.push(line);
  return keys
    .map((s) => s.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter((k): k is string => !!k);
}

describe("settings.save allowlist", () => {
  it("accepts every key the Settings page actually sends", () => {
    const settingsPage = readFileSync(
      join(ROOT, "client/src/pages/usip/Settings.tsx"),
      "utf8",
    );
    const adminRouter = readFileSync(join(ROOT, "server/routers/admin.ts"), "utf8");

    // Isolate the save mutation's input schema so we don't accidentally match
    // key names belonging to other procedures in the same file.
    const saveIdx = adminRouter.indexOf("save: adminWsProcedure");
    expect(saveIdx, "settings save mutation not found — did it get renamed?").toBeGreaterThan(-1);
    const schemaBlock = adminRouter.slice(saveIdx, saveIdx + 4000);

    const sentKeys = new Set(
      extractSaveCallBodies(settingsPage).flatMap(topLevelKeys),
    );
    expect(sentKeys.size, "no save({...}) calls found — extraction likely broke").toBeGreaterThan(3);

    // `\s*` between `z` and `.` matters: some entries wrap the chain onto the
    // next line (e.g. `notifyPolicy: z\n  .record(...)`).
    const missing = [...sentKeys].filter(
      (k) => !new RegExp(`\\b${k}\\s*:\\s*z\\s*\\.`).test(schemaBlock),
    );

    expect(
      missing,
      `These keys are sent by Settings.tsx but missing from the settings.save zod allowlist, ` +
        `so they are silently stripped and the save no-ops while reporting success: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
