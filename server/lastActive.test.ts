/**
 * `workspace_members.lastActiveAt` — the Team page has rendered a "Last active"
 * column since it was written, and NOTHING ever wrote the column. Its only
 * references were the schema declaration, the SELECT in team.list, the cell in
 * Team.tsx, and a doc comment on the router advertising that team.list returns
 * "(Members + deactivated + lastActive)". Every member read "—", forever, which
 * a manager can reasonably read as "nobody has logged in".
 *
 * Found by scanning for columns the client displays that no insert/update
 * writes. That scan is noisy — shorthand keys, spreads and `.values(rows)` all
 * look like "never written" — so most of its 96 hits were false. This one was
 * verified exhaustively: four references in the entire repo, none of them a
 * write, and team.updateMember's memberPatch is an explicit allowlist
 * (title/role/quota/notifEmail) so it cannot be set that way either.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAST_ACTIVE_REFRESH_MS, shouldRefreshLastActive } from "./_core/workspace";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("shouldRefreshLastActive", () => {
  const now = 1_700_000_000_000;

  it("refreshes when never set", () => {
    expect(shouldRefreshLastActive(null, now)).toBe(true);
    expect(shouldRefreshLastActive(undefined, now)).toBe(true);
  });

  it("does NOT refresh a timestamp inside the window", () => {
    // The whole point of the throttle: every authenticated request reaches this
    // middleware, so an unthrottled write is one UPDATE per request.
    expect(shouldRefreshLastActive(new Date(now - 1000), now)).toBe(false);
    expect(shouldRefreshLastActive(new Date(now - (LAST_ACTIVE_REFRESH_MS - 1)), now)).toBe(false);
  });

  it("refreshes once the window has elapsed", () => {
    expect(shouldRefreshLastActive(new Date(now - LAST_ACTIVE_REFRESH_MS), now)).toBe(true);
    expect(shouldRefreshLastActive(new Date(now - 60 * 60 * 1000), now)).toBe(true);
  });

  it("refreshes on an unparseable value rather than going quiet", () => {
    expect(shouldRefreshLastActive(new Date("not a date"), now)).toBe(true);
  });

  it("refreshes on a FUTURE timestamp instead of wedging permanently stale", () => {
    // Clock skew between app instances, or a bad manual write, would otherwise
    // leave `now - t` negative forever and the column frozen.
    expect(shouldRefreshLastActive(new Date(now + 60_000), now)).toBe(true);
  });
});

describe("the column is actually written", () => {
  it("workspaceProcedure sets lastActiveAt", () => {
    // The regression this guards is not a wrong value, it is NO value: a column
    // displayed by the UI that no code path writes.
    const src = read("server/_core/workspace.ts");
    expect(src).toMatch(/\.set\(\{\s*lastActiveAt:/);
    expect(src).toContain("shouldRefreshLastActive");
  });

  it("the write is fire-and-forget, so presence tracking cannot fail a request", () => {
    const src = read("server/_core/workspace.ts");
    // Awaiting it would put a write on the critical path of every request that
    // crosses the throttle, and a DB hiccup would surface as a failed read.
    expect(src).toMatch(/void db\s*\n?\s*\.update\(workspaceMembers\)/);
    expect(src).toMatch(/\.catch\(/);
  });

  it("Team.tsx still displays it (otherwise the write has no consumer)", () => {
    // Both directions: a write nobody reads is the same bug pointing the other
    // way, and this one exists because the read had no writer.
    expect(read("client/src/pages/usip/Team.tsx")).toContain("lastActiveAt");
  });
});
