/**
 * A member who has left must stop being ACTED AS, not just stop signing in.
 *
 * THE SEAM: `3366f4b` established that deactivation has to revoke access, and
 * closed it in `resolveWorkspace` — the choke point every authenticated request
 * passes through. That gate is INBOUND ONLY. It says nothing about the paths
 * that resolve a user id from a row written months earlier, with no session
 * anywhere near them:
 *
 *   booking_links.userId          → /b/:slug books a meeting on their calendar
 *   chat_agents.bookingUserId     → /c/:slug offers their slots, files their leads
 *   forms.createdByUserId         → a public form submission is filed under them
 *   landing_pages.createdByUserId → same, for /l/:slug
 *   lead_routing_rules.targetUserIds → they keep their share of the round-robin
 *   {{bookingLink}}               → outbound mail links a prospect to them
 *   pickWorkspaceOwner            → the autopilot's meetings are owned by them
 *
 * The booking case is the sharpest, and it is worth stating in full because it
 * is what the assertions below are protecting: with the host gone,
 * `busyEventsFor` finds no calendar events, so EVERY slot reads as open;
 * `sendMeetingInvite` finds no calendar account, so the meeting is stored with
 * `inviteSent: false` and no invite is ever sent; and the "new meeting booked"
 * notification is addressed to a user id that cannot sign in. The prospect is
 * told they have a meeting. Nobody in the workspace is told anything.
 *
 * WHY SOURCE-SCANNED, mostly. Every one of these decisions is a DB read, so
 * there is no pure function to call — the same verdict `senderFallback` and
 * `approvalQueueRanking` reached. What is pinned is the GATE ON EACH PATH, in
 * a window bounded by the decision and the write it guards, never a whole file
 * (`b15490d`: one gated endpoint satisfies a file-level `toContain` forever, no
 * matter how many ungated siblings join it).
 *
 * The one genuinely pure consumer — `pickRoutingMatch` — is called for real.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { pickRoutingMatch } from "./leadScoring";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Comments are stripped everywhere: this file's own prose names every symbol
 *  it asserts on, and a guard that a comment can satisfy is not a guard
 *  (`8ec606b`, `fcaa531` — twice in this repo). */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Slice `src` between two anchors, asserting BOTH were found and that the
 * window is real code rather than a fragment.
 *
 * `indexOf` returning −1 is the single most common way a scanner in this repo
 * has lied: a one-arg `slice(-1)` yields the file's LAST CHARACTER, against
 * which every `not.toMatch` passes and every `toContain` fails for the wrong
 * reason. Both ends are asserted, and so is a length floor.
 */
function windowBetween(src: string, startAnchor: string, endAnchor: string, minLen = 120): string {
  const at = src.indexOf(startAnchor);
  expect(at, `start anchor not found — every assertion on this window would be meaningless: ${startAnchor}`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, at + startAnchor.length);
  expect(end, `end anchor not found after the start — the window would run to EOF: ${endAnchor}`).toBeGreaterThan(at);
  const w = src.slice(at, end);
  expect(w.length, `window between the anchors is too small to be the real block: ${startAnchor}`).toBeGreaterThan(minLen);
  return w;
}

/**
 * Every path that resolves an owner without a session, the window it must be
 * gated in, and the gate it must call.
 *
 * Each window runs from the DECISION to the WRITE it guards, so deleting the
 * gate — or moving it after the write — fails here.
 *
 * 🔴 EVERY `gate` PINS THE STATEMENT, NOT THE CALL. A regex that only looks for
 * `isActiveMember(...)` is satisfied by `if (false && !(await isActiveMember(...)))`
 * — the exact mutation that walked through `enrollmentDedupe`, and the reason
 * that guard had to be rewritten. So the refusal (`throw`, `return null`) or
 * the BINDING (`x = await activeOwnerOrNull(...)`) is part of the pattern:
 * neutering the check changes the surrounding text and fails here.
 */
const SURFACES: Array<{
  what: string;
  file: string;
  start: string;
  end: string;
  gate: RegExp;
}> = [
  {
    what: "the public booking page refuses a departed host",
    file: "server/routers/bookingLinks.ts",
    start: "getPublic: publicProcedure",
    end: "book: publicProcedure",
    gate: /if \(!\(await isActiveMember\(link\.workspaceId, link\.userId\)\)\) \{\s*throw new TRPCError\(\{ code: "NOT_FOUND"/,
  },
  {
    what: "booking a slot refuses a departed host (the chat agent books through here too)",
    file: "server/routers/bookingLinks.ts",
    start: "export async function bookSlotForLink(",
    end: "db.insert(meetings)",
    gate: /if \(!\(await isActiveMember\(link\.workspaceId, link\.userId\)\)\) \{\s*throw new TRPCError\(\{ code: "NOT_FOUND"/,
  },
  {
    what: "{{bookingLink}} does not resolve to a departed rep",
    file: "server/mergeVars.ts",
    start: "export async function resolveBookingUrl(",
    end: "return `${baseUrl.replace",
    gate: /if \(!\(await isActiveMember\(workspaceId, userId\)\)\) return "";/,
  },
  {
    what: "the chat agent stops offering a departed rep's calendar",
    file: "server/routers/chatAgents.ts",
    start: "async function linkForAgent(",
    end: "const contentInput = z.object({",
    gate: /if \(!\(await isActiveMember\(agent\.workspaceId, userId\)\)\) return null;/,
  },
  {
    what: "a chat-sourced lead is not filed under a departed rep",
    file: "server/routers/chatAgents.ts",
    start: "async function createLeadForSession(",
    end: "db.insert(leads)",
    gate: /ownerUserId: number \| null = await activeOwnerOrNull\(\s*agent\.workspaceId,/,
  },
  {
    what: "a chat handoff task is not assigned to a departed rep",
    file: "server/routers/chatAgents.ts",
    start: "async function handoffToRep(",
    end: "db.insert(tasks)",
    gate: /const ownerUserId = await activeOwnerOrNull\(\s*agent\.workspaceId,/,
  },
  {
    what: "a public form submission is not filed under a departed author",
    file: "server/routers/forms.ts",
    start: "if (form.autoCreateLead",
    end: "db.insert(leads)",
    gate: /ownerUserId: number \| null = await activeOwnerOrNull\(form\.workspaceId, form\.createdByUserId\)/,
  },
  {
    what: "a landing-page submission is not filed under a departed author",
    file: "server/routers/landingPages.ts",
    start: "if (page.autoCreateLead",
    end: "db.insert(leads)",
    gate: /ownerUserId: number \| null = await activeOwnerOrNull\(page\.workspaceId, page\.createdByUserId\)/,
  },
  {
    what: "lead-routing targets are filtered to active members before a rule picks one",
    file: "server/routers/leadScoring.ts",
    start: "export async function routeLeadOwner(",
    end: "const m = pickRoutingMatch(",
    // The filter must CONSUME the lookup: a rule list built from the raw
    // column while `active` sits unused would satisfy a bare `activeMemberIds(`.
    gate: /targetUserIds: \(\(\(r\.targetUserIds as number\[\] \| null\) \?\? \[\]\)\.filter\(\(u\) => active\.has\(u\)\)\)/,
  },
  {
    what: "the autopilot's meeting owner is an active member",
    file: "server/services/meetingScheduler.ts",
    start: "async function pickWorkspaceOwner(",
    end: "return members[0]",
    // Both terms of the WHERE, together: `isNull(deactivatedAt)` on its own,
    // with the workspace term dropped, would rank members of every workspace.
    gate: /and\(eq\(workspaceMembers\.workspaceId, workspaceId\), isNull\(workspaceMembers\.deactivatedAt\)\)/,
  },
];

describe("every session-less path that names a member gates on active membership", () => {
  /**
   * FLOOR. Without it, a table that lost its entries — or a filter typo that
   * emptied it — would report a clean sweep by checking nothing. The count is
   * pinned rather than bounded so that REMOVING a surface is also a decision.
   */
  it("checks every surface in the table, and the table has not shrunk", () => {
    expect(SURFACES.length).toBe(10);
    expect(new Set(SURFACES.map((s) => `${s.file}::${s.start}`)).size).toBe(SURFACES.length);
  });

  for (const s of SURFACES) {
    it(s.what, () => {
      const w = windowBetween(strip(read(s.file)), s.start, s.end);
      expect(w).toMatch(s.gate);
    });
  }
});

describe("the gate itself", () => {
  const helper = strip(read("server/_core/activeMembers.ts"));

  it("scopes the lookup to the workspace AND to a live membership", () => {
    /**
     * Both terms, because each alone is a different hole:
     *  · drop `workspaceId` and a member of ANY workspace passes for ANY other
     *    — verbatim the `streamRouteAuth` finding;
     *  · drop the deactivatedAt term and the whole gate is decorative.
     */
    const q = windowBetween(helper, "export async function activeMemberIds(", "export async function isActiveMember(");
    expect(q).toMatch(/eq\(workspaceMembers\.workspaceId, workspaceId\)/);
    expect(q).toMatch(/isNull\(workspaceMembers\.deactivatedAt\)/);
    expect(q).toMatch(/inArray\(workspaceMembers\.userId, wanted\)/);
  });

  it("fails CLOSED when there is no database", () => {
    // Returning every id on a null db would turn an outage into an open door.
    const q = windowBetween(helper, "export async function activeMemberIds(", "export async function isActiveMember(");
    expect(q).toMatch(/if \(!db\) return new Set\(\);/);
    expect(q).toMatch(/catch[\s\S]*?return new Set\(\);/);
  });

  it("derives the answer from the query result, not from the input", () => {
    /**
     * The `8893dc8` trap: a mutation left the membership query in place and
     * bound the result to a literal, so "the query exists" and "the check runs
     * first" both stayed true while the gate answered a question nobody asked.
     * The returned Set must be built from the ROWS.
     */
    const q = windowBetween(helper, "export async function activeMemberIds(", "export async function isActiveMember(");
    expect(q).toMatch(/return new Set\(rows\.map\(\(r\) => r\.userId\)\)/);
  });
});

describe("resolveBookingUrl gates BEFORE it provisions", () => {
  /**
   * Ordering is the whole finding here, not presence. `resolveBookingUrl` is a
   * get-or-CREATE: a membership check placed after the lazy branch would mint a
   * brand-new booking link for a non-member and then decline to return it,
   * leaving a bookable row behind for a person who has left.
   *
   * Same lesson as `scheduledEndpointAuth` — presence and ordering are separate
   * assertions, and a scanner that only proves presence proves nothing.
   */
  const fn = windowBetween(
    strip(read("server/mergeVars.ts")),
    "export async function resolveBookingUrl(",
    "return `${baseUrl.replace",
  );

  it("the lazy-provision branch is inside the window (or the ordering test is vacuous)", () => {
    expect(fn).toMatch(/db\.insert\(bookingLinks\)/);
  });

  it("the membership check precedes the insert", () => {
    const gateAt = fn.search(/isActiveMember\(workspaceId, userId\)/);
    const insertAt = fn.search(/db\.insert\(bookingLinks\)/);
    expect(gateAt, "the membership check is missing entirely").toBeGreaterThan(-1);
    expect(insertAt, "the lazy insert is missing — re-anchor this test").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(insertAt);
  });

  it("the check gates a RETURN, not just a log", () => {
    expect(fn).toMatch(/if \(!\(await isActiveMember\(workspaceId, userId\)\)\) return "";/);
  });
});

describe("team.delete turns off the leaver's public booking page", () => {
  /**
   * Bounded to the delete procedure. A file-level search would be satisfied by
   * any other `update(bookingLinks)` in admin.ts — the exact weakness that let
   * two ungated cron endpoints ship in `b15490d`.
   */
  const proc = windowBetween(
    strip(read("server/routers/admin.ts")),
    "  delete: adminWsProcedure",
    "  bulkChangeRole: adminWsProcedure",
    400,
  );

  it("deactivates the booking link, scoped to the workspace and the target", () => {
    expect(proc).toMatch(/\.update\(bookingLinks\)/);
    expect(proc).toMatch(/\.set\(\{ active: false \}\)/);
    expect(proc).toMatch(/eq\(bookingLinks\.workspaceId, ctx\.workspace\.id\)/);
    expect(proc).toMatch(/eq\(bookingLinks\.userId, target\.userId\)/);
  });

  it("happens before the membership row is removed", () => {
    // Afterwards there is no row left to identify them by — the same reason the
    // saved-report recipient strip sits where it does.
    const upd = proc.search(/\.update\(bookingLinks\)/);
    const del = proc.search(/\.delete\(workspaceMembers\)/);
    expect(upd, "the booking-link deactivate is missing").toBeGreaterThan(-1);
    expect(del, "the membership delete is missing — re-anchor this test").toBeGreaterThan(-1);
    expect(upd).toBeLessThan(del);
  });
});

describe("pickRoutingMatch, called for real, never routes to a filtered-out rep", () => {
  /**
   * The only pure consumer in the class, so it is exercised rather than
   * scanned. What is proven here is the CONTRACT `routeLeadOwner` relies on
   * when it hands over a filtered target list: an empty list falls through to
   * the next rule instead of matching with nobody, and the stored cursor stays
   * in range against the SHORTER list.
   */
  const always = () => true;
  const rule = (over: Partial<Parameters<typeof pickRoutingMatch>[0][number]>) => ({
    id: 1, enabled: true, priority: 1, conditions: {}, strategy: "round_robin",
    targetUserIds: [], rrCursor: 0, ...over,
  }) as Parameters<typeof pickRoutingMatch>[0][number];

  it("falls through to the next rule when every target has left", () => {
    const m = pickRoutingMatch(
      [rule({ id: 1, priority: 1, targetUserIds: [] }), rule({ id: 2, priority: 2, targetUserIds: [77] })],
      {} as any,
      always,
    );
    expect(m?.ruleId).toBe(2);
    expect(m?.ownerUserId).toBe(77);
  });

  it("returns no match at all rather than an owner when NO rule has a live target", () => {
    // null becomes an unowned lead the workspace can claim — the deliberate
    // outcome. A ghost owner looks handled and is not.
    expect(pickRoutingMatch([rule({ targetUserIds: [] })], {} as any, always)).toBeNull();
  });

  it("keeps a stale cursor in range against the shorter list", () => {
    /**
     * `rrCursor` is stored per rule and indexes into targetUserIds. Removing a
     * departed rep shortens that list under a cursor written when it was
     * longer, so an unclamped index would return undefined — an owner column
     * silently set to nothing, by a different route than the intended one.
     */
    const m = pickRoutingMatch([rule({ targetUserIds: [11, 22], rrCursor: 9 })], {} as any, always);
    expect([11, 22]).toContain(m!.ownerUserId);
    expect(m!.newCursor).toBeGreaterThanOrEqual(0);
    expect(m!.newCursor).toBeLessThan(2);
  });

  it("rotates across the survivors instead of pinning one", () => {
    // A filtered list must still round-robin; collapsing to targets[0] would
    // hand every inbound lead to one person.
    const first = pickRoutingMatch([rule({ targetUserIds: [11, 22], rrCursor: 0 })], {} as any, always);
    const second = pickRoutingMatch([rule({ targetUserIds: [11, 22], rrCursor: first!.newCursor! })], {} as any, always);
    expect(first!.ownerUserId).not.toBe(second!.ownerUserId);
  });
});

describe("the surface table stays in step with the code", () => {
  /**
   * BOTH DIRECTIONS. Forward: every table entry must name a file that really
   * imports the helper — matched against a real `import … from` LINE, because
   * checking whether the module name appears ANYWHERE in the file matches the
   * comments this test file's fixes just wrote (`fcaa531`, then `8ec606b`
   * repeating it exactly). Backward: every file that imports the helper must be
   * in the table, so a new consumer cannot be added without a gate assertion.
   */
  const importsHelper = (file: string) =>
    /^import \{[^}]*\} from "[^"]*_core\/activeMembers";$/m.test(read(file));

  const tableFiles = Array.from(new Set(SURFACES.map((s) => s.file)))
    // meetingScheduler gates inline on the column rather than through the
    // helper — it is already inside a workspace-scoped query and has the
    // members table in hand, so a second round trip would buy nothing.
    .filter((f) => f !== "server/services/meetingScheduler.ts");

  it("every table file really imports the gate", () => {
    expect(tableFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of tableFiles) {
      expect(importsHelper(f), `${f} is in the table but does not import _core/activeMembers`).toBe(true);
    }
  });

  it("no file imports the gate without appearing in the table", () => {
    const consumers = globSourceFiles().filter(importsHelper);
    expect(consumers.length, "nothing imports the gate — the scan is broken").toBeGreaterThanOrEqual(6);
    for (const f of consumers) {
      expect(
        tableFiles,
        `${f} imports the membership gate but has no entry in SURFACES — add one naming the window it guards`,
      ).toContain(f);
    }
  });
});

/** Every .ts under server/, excluding tests and the helper itself. */
function globSourceFiles(): string[] {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      if (rel === "server/_core/activeMembers.ts") continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}
