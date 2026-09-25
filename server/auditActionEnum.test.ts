/**
 * Every audit action written anywhere on the server is a value the database
 * accepts (2026-09-25). audit_log.action is a MySQL ENUM; a verb outside it
 * ("book", "complete", "fork_template", …) is rejected by the database and
 * recordAudit swallows the error, so twelve actions across five routers were
 * silently never recorded. The type (AuditAction) says the same thing, but the
 * owner's tsc gate tolerates a baseline of errors, so a new violation would
 * only have moved a count. This test fails on it instead.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function serverSources(dir = "server"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...serverSources(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const schema = readFileSync("drizzle/schema.ts", "utf8");
const enumMatch = schema.match(/export const auditLog = mysqlTable\([\s\S]*?action: mysqlEnum\("action", \[([^\]]+)\]\)/);
const ALLOWED = new Set((enumMatch?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean));

describe("audit actions", () => {
  it("the database's list is what the AuditAction type allows", () => {
    expect([...ALLOWED].sort()).toEqual(["create", "delete", "login", "logout", "scim", "update"]);
    const audit = readFileSync("server/audit.ts", "utf8");
    expect(audit).toContain('type AuditAction = "create" | "update" | "delete" | "login" | "logout" | "scim";');
  });

  it("no recordAudit call anywhere on the server uses a verb the database rejects", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const file of serverSources()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/recordAudit\(\{[\s\S]{0,200}?\baction: "([a-z_]+)"/g)) {
        seen++;
        if (!ALLOWED.has(m[1])) bad.push(`${file}: "${m[1]}"`);
      }
    }
    // A scan that finds nothing proves nothing.
    expect(seen).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });
});
