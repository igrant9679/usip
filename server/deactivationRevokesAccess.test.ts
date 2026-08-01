/**
 * Deactivating a member must revoke their access. It did not.
 *
 * THE SEAM: the role hierarchy was consolidated in `1bbed68`, but nobody had
 * asked whether the membership row itself still means "may act". It does not —
 * `workspace_members.deactivatedAt` exists, `team.deactivate` sets it, and NO
 * AUTHORIZATION PATH LOOKED AT IT. `deactivatedAt` appeared nowhere in
 * `server/_core/` at all.
 *
 * What deactivation already did: reassign the member's leads, opportunities and
 * open tasks to someone else, hide them from the Team list, mark them
 * "deactivated", and refuse to reassign work TO them ("Reassign target is
 * deactivated"). Every signal in the product says this person is out.
 *
 * What it did not do: stop them. A deactivated member kept their session
 * cookie, could sign in again with their password, and passed every gate at
 * whatever role they still held — including admin. Offboarding a leaver removed
 * their work, not their access.
 *
 * FOUR authorization paths shared the hole:
 *   _core/workspace.ts    resolveWorkspace — EVERY tRPC request
 *   _core/streamHelpers   resolveStreamAuth — all five SSE routes
 *   _core/storageProxy    customer documents
 *   unipileWebhook        connecting an account to the workspace
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
/** Line-leading block comments only — a `/*` inside a string is not a comment. */
const strip = (s: string) =>
  s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

/** Every path whose membership lookup decides whether a request may proceed. */
const AUTH_PATHS = [
  "server/_core/workspace.ts",
  "server/_core/streamHelpers.ts",
  "server/_core/storageProxy.ts",
  "server/unipileWebhook.ts",
  /**
   * `db.ts` was MISSED by the first pass of this fix. getUserWorkspaces is the
   * workspace SWITCHER list — and `workspace.switch` uses it as its
   * authorization check ("Not a member of that workspace"), so an unfiltered
   * list authorised on a stale answer while the leaver went on seeing the
   * workspace they had been removed from.
   */
  "server/db.ts",
];

/**
 * Membership lookups that deliberately do NOT filter, with the reason.
 *
 * Keyed by the bound variable, or by the enclosing function when the query is
 * returned directly — whichever says what the lookup is FOR. A listing is not
 * an authorization.
 */
const UNFILTERED_ALLOWED: Record<string, string> = {
  everMember:
    "resolveWorkspace: chooses between 'your access was deactivated' and 'you have no workspace'. Never authorizes anything — the active lookup above it already failed.",
  getWorkspaceMembers:
    "The Team DIRECTORY. Deactivated members must appear here — the page renders them with a 'deactivated' state behind a showInactive toggle. Filtering would hide the very thing an admin came to check.",
};

/**
 * Each `.from(workspaceMembers)` statement, sliced to its terminating `;`.
 *
 * The binding is the LAST `const x = await` before the lookup, not the first in
 * the window — the window reaches back 400 chars and routinely contains an
 * earlier statement, so taking the first match named the wrong variable and the
 * allowlist silently matched nothing.
 */
function membershipLookups(src: string): { binding: string; stmt: string }[] {
  const out: { binding: string; stmt: string }[] = [];
  for (const m of src.matchAll(/\.from\(workspaceMembers\)/g)) {
    const end = src.indexOf(";", m.index);
    const window = Math.max(0, m.index - 400);
    const before = src.slice(window, m.index);
    const bindings = [...before.matchAll(/const\s+\[?(\w+)\]?\s*=\s*await/g)];
    const last = bindings.length ? bindings[bindings.length - 1] : null;
    /**
     * Label = the bound variable, else the enclosing function.
     *
     * `db` is excluded: every function here opens with `const db = await
     * getDb()`, so it is always the nearest binding and it names nothing. With
     * it included, two different lookups in db.ts both labelled themselves "db"
     * and neither could be allowlisted or argued about. Kept for SLICING (it
     * bounds the statement) but never used as the name.
     */
    const named = bindings.filter((b) => b[1] !== "db");
    let binding = named.length ? named[named.length - 1][1] : "";
    if (!binding) {
      const fns = [...src.slice(0, m.index).matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)];
      binding = fns.length ? fns[fns.length - 1][1] : "";
    }
    /**
     * Start the statement AT ITS OWN BINDING, not a fixed distance back.
     *
     * With a flat 400-char lookback the window bled into the PREVIOUS
     * statement, so removing the filter from the fallback query still "passed"
     * — the header query's isNull was sitting in the same window. A scanner
     * whose window overlaps its neighbours reports on the wrong statement.
     */
    const stmtStart = last ? window + last.index! : window;
    const stmt = src.slice(stmtStart, end < 0 ? m.index + 400 : end);
    out.push({ binding, stmt });
  }
  return out;
}

describe("the scanner has something to scan", () => {
  it("finds membership lookups in every auth path", () => {
    for (const rel of AUTH_PATHS) {
      const found = membershipLookups(strip(readFileSync(join(ROOT, rel), "utf8")));
      expect(found.length, `${rel} has no membership lookup — has it moved?`).toBeGreaterThan(0);
    }
  });
});

describe("every authorization lookup excludes deactivated members", () => {
  it.each(AUTH_PATHS)("%s", (rel) => {
    const src = strip(readFileSync(join(ROOT, rel), "utf8"));
    const offenders = membershipLookups(src)
      .filter((l) => !/deactivatedAt/.test(l.stmt))
      .filter((l) => !(l.binding in UNFILTERED_ALLOWED))
      .map((l) => l.binding || "(unnamed)");
    expect(
      offenders,
      offenders.length
        ? `\n\n${rel}: membership lookup(s) that authorize without excluding\n` +
            `deactivated members: ${offenders.join(", ")}\n\n` +
            `A deactivated member keeps their session and their role. Add\n` +
            `isNull(workspaceMembers.deactivatedAt) — or, if the lookup genuinely\n` +
            `does not authorize, name it in UNFILTERED_ALLOWED with the reason.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const all = AUTH_PATHS.flatMap((rel) =>
      membershipLookups(strip(readFileSync(join(ROOT, rel), "utf8"))).map((l) => l.binding),
    );
    const stale = Object.keys(UNFILTERED_ALLOWED).filter((k) => !all.includes(k));
    expect(
      stale,
      stale.length ? `\n\nAllowlisted but no longer present — drop it:\n  ${stale.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});

describe("resolveWorkspace", () => {
  const src = strip(readFileSync(join(ROOT, "server/_core/workspace.ts"), "utf8"));

  it("falls THROUGH a deactivated header workspace instead of throwing", () => {
    /**
     * Someone deactivated in one workspace may still be active in another and
     * should land there rather than be locked out of everything.
     *
     * Anchored on CODE. The first version sliced to `indexOf("Fallback")` — a
     * word that only exists in a `//` comment, which this file strips before
     * scanning. indexOf returned -1, the slice came back empty, and the
     * assertion was inspecting nothing. That exact trap is in SESSION_STATUS's
     * table and I walked into it anyway.
     */
    /**
     * Anchored on the CLAUSE, not a block boundary: the header query and the
     * fallback query are both `const rows = await db`, so slicing to the next
     * occurrence of that string ended the slice INSIDE the block it was meant
     * to contain. Non-unique indexOf — the second trap from the same table.
     */
    const wsIdClause = /and\(\s*eq\(workspaceMembers\.userId, userId\),\s*eq\(workspaceMembers\.workspaceId, wsId\),([\s\S]{0,120}?)\)\)/.exec(src);
    expect(wsIdClause, "the header-workspace lookup was not found").not.toBeNull();
    expect(wsIdClause![1]).toContain("isNull(workspaceMembers.deactivatedAt)");

    // And it must not lock out someone still active elsewhere.
    const start = src.indexOf("if (headerVal)");
    const headerBlock = src.slice(start, src.indexOf("if (rows[0]) return", start));
    expect(headerBlock).not.toMatch(/throw new TRPCError/);
  });

  it("tells a deactivated user WHY, rather than a bare NO_WORKSPACE", () => {
    expect(src).toMatch(/code: "FORBIDDEN"/);
    expect(src).toMatch(/has been deactivated/i);
  });

  it("still distinguishes never-a-member from deactivated", () => {
    expect(src).toContain("NO_WORKSPACE");
  });
});

/**
 * A NON-OBVIOUS DEPENDENCY, pinned because the safe version looks arbitrary.
 *
 * `workspace.list` auto-bootstraps a seeded demo workspace when
 * getUserWorkspaces returns nothing. Now that that list excludes deactivated
 * memberships, the ONLY thing stopping a deactivated user being handed a brand
 * new workspace is that `ensureUserHasWorkspace` guards on ANY membership row
 * rather than an active one.
 *
 * Narrowing that guard to active-only would read like a tidy-up and would
 * silently turn offboarding into provisioning.
 */
describe("deactivation cannot bootstrap a fresh workspace", () => {
  const seed = strip(readFileSync(join(ROOT, "server/seed.ts"), "utf8"));

  it("ensureUserHasWorkspace bails on ANY membership row, active or not", () => {
    const fn = seed.slice(seed.indexOf("export async function ensureUserHasWorkspace"));
    const guard = fn.slice(0, fn.indexOf("const slug"));
    expect(guard, "the early-return guard is gone").toMatch(/existing\.length > 0/);
    expect(
      guard,
      "\n\nThis guard must NOT filter on deactivatedAt. workspace.list bootstraps\n" +
        "a new seeded workspace when the (now active-only) membership list is\n" +
        "empty — so filtering here would hand a deactivated leaver a fresh\n" +
        "workspace instead of locking them out.\n",
    ).not.toMatch(/deactivatedAt/);
  });

  it("workspace.list still routes through that guard", () => {
    const ws = strip(readFileSync(join(ROOT, "server/routers/workspace.ts"), "utf8"));
    expect(ws).toContain("ensureUserHasWorkspace");
  });
});

/**
 * Copy-to-code, the method from the confirm-dialog seam: the product presents
 * deactivation as offboarding, so the code has to treat it that way.
 */
describe("the product presents deactivation as removal", () => {
  const team = readFileSync(join(ROOT, "client/src/pages/usip/Team.tsx"), "utf8");
  const admin = readFileSync(join(ROOT, "server/routers/admin.ts"), "utf8");

  it("the Team page treats deactivated as a distinct, hidden state", () => {
    expect(team).toMatch(/deactivated/);
    expect(team).toMatch(/showInactive/);
  });

  it("deactivate reassigns their work and sets the flag", () => {
    expect(admin).toMatch(/set\(\{ deactivatedAt: new Date\(\) \}\)/);
  });

  it("reactivate clears it, so the flag is the switch", () => {
    expect(admin).toMatch(/set\(\{ deactivatedAt: null \}\)/);
  });
});
