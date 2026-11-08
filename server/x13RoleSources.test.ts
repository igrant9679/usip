/**
 * Role checks read the WORKSPACE role, through the one rank map (audit
 * 2026-10-20, X1.3; final pass 2026-11-07).
 *
 * `useAuth().user.role` is the platform role, "user" or "admin". Ranking it
 * as a workspace role denied every workspace manager and admin whose
 * platform role is "user" (Calendar, Mailbox, Company profile, the prospect
 * scoring panel), and showed controls to a platform admin the server would
 * refuse. Those sites read useWorkspaceRole() now; SequencesV2 hand-rolled a
 * role list and reads it too. These guards keep it that way: the platform
 * role is read only where a platform-owner feature means it, and nobody
 * ranks a role with a list of names instead of shared/roleRank.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
function files(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") out.push(...files(p, re)); }
    else if (re.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
/** Drop comments, so a comment that names the old mistake is not a hit. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the client reads the workspace role", () => {
  const client = files(join(ROOT, "client", "src"), /\.tsx?$/);

  it("finds the client source (guards the scanner)", () => {
    expect(client.length).toBeGreaterThan(100);
  });

  /**
   * The two places the PLATFORM role is the right one: editing the global
   * page descriptions (pageDescriptions.update allows only users.role =
   * "admin") and the platform-wide spend report (spend.platform, the same).
   */
  const PLATFORM_ROLE_SITES: Record<string, number> = {
    "client/src/components/usip/Shell.tsx": 1,
    "client/src/components/usip/SpendReport.tsx": 1,
  };

  it("useAuth()'s user.role is read only where a platform-owner feature means it", () => {
    const hits: Record<string, number> = {};
    for (const f of client) {
      const n = (code(readFileSync(f, "utf8")).match(/\buser\??\.role\b/g) ?? []).length;
      if (n) hits[rel(f)] = n;
    }
    expect(hits).toEqual(PLATFORM_ROLE_SITES);
  });

  it("no role is ranked with a hand-written list of role names", () => {
    const offenders: string[] = [];
    for (const f of client) {
      const src = code(readFileSync(f, "utf8"));
      if (/\[[^\]\n]*"(?:manager|admin|super_admin)"[^\]\n]*\]\s*\.includes\(/.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("the sites the audit named, and SequencesV2, use useWorkspaceRole", () => {
    for (const f of [
      "client/src/pages/usip/Calendar.tsx",
      "client/src/pages/usip/Mailbox.tsx",
      "client/src/pages/usip/CompanyProfile.tsx",
      "client/src/components/usip/scoring/ProspectScoringPanel.tsx",
      "client/src/pages/usip/SequencesV2.tsx",
    ]) {
      expect(read(f), f).toContain("useWorkspaceRole()");
    }
    expect(read("client/src/pages/usip/SequencesV2.tsx")).toContain("const isManager = useWorkspaceRole().isManager;");
  });
});

describe("the server reads the platform role only for platform-owner features", () => {
  it("ctx.user.role appears only where users.role = admin is the point", () => {
    const server = files(join(ROOT, "server"), /\.ts$/);
    const hits: string[] = [];
    for (const f of server) {
      const src = code(readFileSync(f, "utf8"));
      if (/\bctx\.user\??\.role\b/.test(src)) hits.push(rel(f));
    }
    // adminProcedure (trpc.ts), the global page descriptions, and the
    // platform-wide row counts in danger-zone tableStatus (admin.ts).
    // Workspace gates use ctx.member.role through requireMinRole and the
    // role procedures.
    expect(hits.sort()).toEqual(["server/_core/trpc.ts", "server/routers/admin.ts", "server/routers/pageDescriptions.ts"]);
  });
});
