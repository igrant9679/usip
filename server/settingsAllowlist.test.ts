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

/** Brace-matched object body starting at the `{` index given. */
function bracedBodyAt(src: string, braceIdx: number): string | null {
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceIdx + 1, i);
    }
  }
  return null;
}

/**
 * Every call site that reaches `trpc.settings.save` — and ONLY those.
 *
 * The marker used to be the bare literal `save({`, which misses
 * `saveMut.mutate({ ... })`. Two of those are settings.save (the workspace
 * messaging section and the email-verification toggle) and between them send
 * five keys that nothing checked; one of them uses `as any`, so TypeScript
 * would not have caught a stray key either. Deleting a key from the zod
 * allowlist — the exact "save returns ok:true and silently drops it" bug this
 * file exists for — passed.
 *
 * Resolution is PER SITE, not per name, and that is the load-bearing part.
 * `saveMut` is settings.save in two components and integrations.save in a
 * third; `save` is bound to four different procedures in this one file
 * (settings.save, smtpConfig.save, profile.updateMySignature,
 * placesSearch.saveBudget). Matching on the identifier alone would check
 * integrations' `provider` and smtpConfig's `host`/`port` against the settings
 * allowlist and fail on keys that were never meant for it — a false failure,
 * which is how a guard gets deleted rather than fixed.
 */
function extractSaveCallBodies(src: string): string[] {
  const bodies: string[] = [];

  /**
   * 1. The `save(...)` PROP. Settings() owns the settings.save mutation and
   *    threads `save: (v: any) => void` into BrandingTab / SecurityTab /
   *    NotificationsTab / ProposalsTab / GeneralTab, which call it directly.
   */
  for (const m of src.matchAll(/\bsave\(\{/g)) {
    const body = bracedBodyAt(src, m.index! + m[0].length - 1);
    if (body !== null) bodies.push(body);
  }

  /** 2. Locally-declared mutations invoked as `<ident>.mutate({ ... })`. */
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.mutate\(\{/g)) {
    const ident = m[1];
    let proc: string | null = null;
    for (const d of src.matchAll(
      new RegExp(`const\\s+${ident}\\s*=\\s*trpc\\.([\\w.]+)\\.useMutation\\(`, "g"),
    )) {
      if (d.index! > m.index!) break; // declarations are ordered; take the nearest ABOVE
      proc = d[1];
    }
    if (proc !== "settings.save") continue;
    const body = bracedBodyAt(src, m.index! + m[0].length - 1);
    if (body !== null) bodies.push(body);
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
    .map((s) => {
      const entry = s.trim();
      /**
       * `key: value` — and ALSO bare `key`, which is ES6 shorthand and is a
       * property just the same.
       *
       * Requiring the colon made `save({ timezone })`, `save({ enforce2fa })`
       * and `save({ autoExtendDays })` invisible: three real settings, none of
       * them ever checked against the allowlist. Deleting `timezone` from the
       * zod schema — the precise "save returns ok:true and drops it" bug — did
       * not fail this file.
       */
      return (
        entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1] ??
        entry.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
      );
    })
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

    const bodies = extractSaveCallBodies(settingsPage);
    const sentKeys = new Set(bodies.flatMap(topLevelKeys));
    expect(sentKeys.size, "no save({...}) calls found — extraction likely broke").toBeGreaterThan(3);

    /**
     * Floors on the SITES, not just the key count. The extractor silently
     * dropped two whole call sites and the key count still looked healthy,
     * because the keys it did see were plentiful. A scan that quietly narrows
     * is the failure mode this repo keeps paying for.
     */
    expect(bodies.length, "far fewer settings.save call sites than expected").toBeGreaterThanOrEqual(9);
    expect(
      sentKeys,
      "the `.mutate({...})` call sites are not being resolved — only the `save(` prop is",
    ).toContain("blockInvalidEmailsFromSequences");
    expect(sentKeys).toContain("systemSenderAccountId");

    // ES6 shorthand entries are properties too. These three were sent as bare
    // identifiers and were invisible until topLevelKeys learned the form.
    for (const shorthand of ["timezone", "enforce2fa", "autoExtendDays"]) {
      expect(
        sentKeys,
        `${shorthand} is sent as shorthand — topLevelKeys has stopped reading that form`,
      ).toContain(shorthand);
    }

    /**
     * And the other direction: keys belonging to the OTHER four mutations in
     * this file must NOT be swept in. `provider` is integrations.save and
     * `host` is smtpConfig.save; neither is a settings column, so their
     * presence here would be a false failure rather than a caught bug.
     */
    for (const foreign of ["provider", "host", "port", "secure"]) {
      expect(
        sentKeys,
        `${foreign} belongs to another mutation in this file — the per-site resolution has broken`,
      ).not.toContain(foreign);
    }

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
