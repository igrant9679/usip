/**
 * The sample-data remover has no marker column to lean on — it recognizes
 * seeded rows by the seed's own fingerprint. That only stays true if the two
 * files keep sharing one vocabulary:
 *
 *  1. every schema table the seeders WRITE is also imported by the remover
 *     (a seeder gaining a table without the remover learning it = sample rows
 *     that survive "Remove sample data" forever);
 *  2. SEED_FINGERPRINT keeps the shape the remover's queries depend on.
 *
 * Source-scanner caveats apply (presence is not effect) — the import-set diff
 * is a coverage CHECKLIST, not proof of deletion. The fingerprint assertions
 * below are behavioral: they import the real constant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SEED_FINGERPRINT } from "./seed";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

/** Table names imported from drizzle/schema by a module (CRLF-safe). */
function schemaImports(src: string): Set<string> {
  const m = src.match(/import \{([\s\S]*?)\} from "\.{1,2}\/(?:\.\.\/)?drizzle\/schema"/);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
}

describe("sample-data removal coverage", () => {
  it("covers every table the CRM seeder writes", () => {
    const seederTables = schemaImports(read("seed.ts"));
    const removerTables = schemaImports(read("services/sampleData.ts"));
    // Imported by the seeder but not data it creates rows in:
    //  - workspaces / workspaceMembers: membership plumbing (ensureUserHasWorkspace)
    //  - auditLog: the re-seed guard reads it
    const notSampleData = new Set(["workspaces", "workspaceMembers", "auditLog"]);
    const missing = [...seederTables].filter((t) => !notSampleData.has(t) && !removerTables.has(t));
    expect(missing).toEqual([]);
  });

  it("covers every table the ARE demo seeder writes", () => {
    const seederTables = schemaImports(read("seedAreDemo.ts"));
    const removerTables = schemaImports(read("services/sampleData.ts"));
    // workspaces: per-workspace iteration; auditLog: the reseed guard READS
    // the removal marker (it re-seeded on every boot without it).
    const notSampleData = new Set(["workspaces", "auditLog"]);
    const missing = [...seederTables].filter((t) => !notSampleData.has(t) && !removerTables.has(t));
    expect(missing).toEqual([]);
  });

  it("SEED_FINGERPRINT keeps the shape the remover's queries anchor on", () => {
    expect(SEED_FINGERPRINT.accountDomains).toHaveLength(24);
    // Every domain is a plausible bare domain — the remover matches leads by
    // email-domain equality, so entries must not carry protocols or paths.
    for (const d of SEED_FINGERPRINT.accountDomains) {
      expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    expect(SEED_FINGERPRINT.sequenceNames).toHaveLength(3);
    expect(SEED_FINGERPRINT.workflowNames).toHaveLength(3);
    expect(SEED_FINGERPRINT.campaignNames).toHaveLength(3);
    expect(SEED_FINGERPRINT.productSkus).toHaveLength(7);
    expect(SEED_FINGERPRINT.territoryNames).toHaveLength(4);
    expect(SEED_FINGERPRINT.dashboardName).toBe("Revenue overview");
  });

  it("the reseed guard consults the removal audit marker", () => {
    // isWorkspaceSeeded must return true for a workspace whose owner removed
    // the samples, or the next login re-seeds everything that was deleted.
    const src = read("seed.ts");
    const fn = src.match(/export async function isWorkspaceSeeded[\s\S]*?\r?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('eq(auditLog.entityType, "sample_data")');
    expect(fn![0]).toContain('eq(auditLog.action, "delete")');
  });
});
