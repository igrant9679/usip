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
    what: "ARE event notifications go to somebody who reads them",
    file: "server/routers/are/notify.ts",
    start: "export async function areNotify(",
    end: "db.insert(notifications)",
    gate: /const recipient = await workspaceNotifyUserId\(opts\.workspaceId\);\s*if \(!recipient\) return;/,
  },
  {
    what: "the proposal-followup cron raises its task on an active member",
    file: "server/emailTracking.ts",
    start: "for (const proposal of staleProposals)",
    end: "db.insert(tasks)",
    gate: /const ownerUserId = await workspaceNotifyUserId\(proposal\.workspaceId\);\s*if \(!ownerUserId\) continue;/,
  },
  {
    what: "a client accepting a proposal from a share link raises a task somebody owns",
    file: "server/routers/proposals.ts",
    start: `if (proposal.status === "accepted") return { ok: true, alreadyAccepted: true };`,
    end: "db.insert(tasks)",
    gate: /const ownerUserId = await workspaceNotifyUserId\(proposal\.workspaceId\);/,
  },
  {
    what: "the unattended auto-send worker picks a present actor",
    file: "server/routers/sequences.ts",
    start: "let actorUserId = ",
    end: "no actor user for draft",
    gate: /let actorUserId = await activeOwnerOrNull\(ws\.workspaceId, draft\.createdByUserId\);\s*if \(!actorUserId\) \{\s*actorUserId = await workspaceNotifyUserId\(ws\.workspaceId\);/,
  },
  {
    what: "the company-backfill cron neither runs nor reports for a workspace with no active owner",
    file: "server/services/enrichmentSweeper.ts",
    start: `if (ws.mode !== "auto") continue;`,
    end: "backfillQueueCompanies({",
    gate: /const recipient = await workspaceNotifyUserId\(ws\.id\);\s*if \(!recipient\) continue;/,
  },
  {
    what: "the enrichment sweep reports to somebody who reads it",
    file: "server/services/enrichmentSweeper.ts",
    start: "emailsFound += r.emailsFound;",
    end: "Enrichment Sweep: ",
    gate: /await notifyOwner\(\s*ws\.id, await workspaceNotifyUserId\(ws\.id\),/,
  },
  {
    what: "an account routed by a territory rule is not filed under a departed rep",
    file: "server/routers/crm.ts",
    start: "const routed = await applyTerritoryRules(",
    end: "db.insert(accounts)",
    gate: /const routedOwner = await activeOwnerOrNull\(ctx\.workspace\.id, routed\.ownerUserId\);\s*if \(routedOwner\) resolvedOwnerId = routedOwner;/,
  },
  {
    what: "the voice agent does not introduce itself on behalf of a departed rep, OUT LOUD, to a caller",
    file: "server/services/voiceBridge.ts",
    start: "let ownerName: string | null = null;",
    end: "const startedAtMs = Date.now();",
    /**
     * The BINDING plus the branch it guards. Deliberately NOT also pinning the
     * identifier used inside the `users` lookup: swapping it back to
     * `agent.ownerUserId` there is an EQUIVALENT MUTANT — the branch is only
     * entered when the gated value is non-null, and in that case the two hold
     * the same number. Mutation W2 proved that rather than exposing a hole, and
     * an assertion added to catch it would be pinning style, not behaviour.
     */
    gate: /const voiceOwnerUserId = await activeOwnerOrNull\(agent\.workspaceId, agent\.ownerUserId\);\s*if \(voiceOwnerUserId\) \{/,
  },
  {
    what: "an inbound call-back reaches somebody who still works here",
    file: "server/voiceWebhook.ts",
    start: "const match = await matchCallerToRecord(",
    end: "db.insert(voiceCalls)",
    gate: /const callOwnerUserId = await activeOwnerOrNull\(agent\.workspaceId, agent\.ownerUserId\);\s*const callNotifyUserId = callOwnerUserId \?\? \(await workspaceNotifyUserId\(agent\.workspaceId\)\);/,
  },
  {
    what: "an ARE promotion does not mint new CRM records owned by a departed campaign owner",
    file: "server/routers/are/execution.ts",
    start: "export async function promoteProspectToCrm(",
    end: "findOrCreateAccount(",
    gate: /const owner =\s*\(await activeOwnerOrNull\(workspaceId, campaign\.ownerUserId\)\) \?\?\s*\(await workspaceNotifyUserId\(workspaceId\)\) \?\?\s*undefined;/,
  },
  {
    what: "a routed-lead notification is not addressed to a departed rep",
    file: "server/services/leadNotifications.ts",
    start: "export async function notifyLeadRouted(",
    end: "db.insert(notifications)",
    gate: /const owner = await activeOwnerOrNull\(notice\.workspaceId, notice\.ownerUserId \?\? null\);\s*if \(!owner\) return false;/,
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
    expect(SURFACES.length).toBe(21);
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

describe("the workspace-owner resolver", () => {
  const helper = strip(read("server/_core/activeMembers.ts"));
  const fn = windowBetween(helper, "export async function workspaceNotifyUserId(", "console.error(\"[activeMembers] workspaceNotifyUserId");

  it("prefers the REAL owner and only then a stand-in", () => {
    /**
     * Order is the whole design. Falling straight to "highest-ranked active
     * member" would quietly redirect every autonomous notification away from a
     * healthy workspace's actual owner — a fix that breaks the normal case to
     * repair the broken one.
     */
    const ownerAt = fn.search(/isActiveMember\(workspaceId, ws\.ownerUserId\)/);
    const fallbackAt = fn.search(/rankOf\(b\.role\) - rankOf\(a\.role\)/);
    expect(ownerAt, "the owner is never consulted").toBeGreaterThan(-1);
    expect(fallbackAt, "there is no stand-in — re-anchor this test").toBeGreaterThan(-1);
    expect(ownerAt).toBeLessThan(fallbackAt);
    expect(fn).toMatch(/if \(ws && \(await isActiveMember\(workspaceId, ws\.ownerUserId\)\)\) return ws\.ownerUserId;/);
  });

  it("the stand-in is drawn only from ACTIVE members", () => {
    expect(fn).toMatch(/and\(eq\(workspaceMembers\.workspaceId, workspaceId\), isNull\(workspaceMembers\.deactivatedAt\)\)/);
  });

  it("returns null rather than guessing when nobody is left", () => {
    expect(fn).toMatch(/if \(members\.length === 0\) return null;/);
  });

  it("reuses the shared rank map instead of declaring a ninth copy", () => {
    // Seven copies of the role hierarchy already existed once (1bbed68), and
    // roleRank.test.ts enforces the single source. A rank map is a permission
    // boundary; a local copy here would decide who hears from the automation.
    expect(helper).toMatch(/^import \{ rankOf \} from "\.\/workspace";$/m);
    expect(helper).not.toMatch(/super_admin:\s*4/);
  });
});

describe("no unattended path reads workspaces.ownerUserId raw any more", () => {
  /**
   * The BACKWARD scan. Six inline lookups existed when this started, in five
   * files, and enumerating the ones I happened to find would say nothing about
   * the seventh somebody adds next month. So the rule is stated as an absence,
   * with an allowlist that has to be argued for.
   *
   * Comments are stripped first — this repo has twice been fooled by a scanner
   * matching prose that a fix had just written.
   */
  const ALLOWED = new Map<string, string>([
    ["server/_core/activeMembers.ts", "the resolver itself — it is what everything else calls"],
    ["server/routers/admin.ts", "the team.delete guard, which must compare against the raw column, and transferOwnership, which writes it"],
  ]);

  it("every raw read is either gone or allowlisted with a reason", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of globSourceFiles()) {
      const src = strip(read(f));
      if (!readsRawOwner(src)) continue;
      scanned++;
      if (!ALLOWED.has(f)) offenders.push(f);
    }
    // FLOOR: the allowlisted files must themselves be found, or the regex has
    // drifted and this scan is passing by looking at nothing.
    expect(scanned, "the scan found no reads at all — the pattern has drifted").toBeGreaterThanOrEqual(ALLOWED.size);
    expect(
      offenders,
      `these read workspaces.ownerUserId directly. An unattended path must call ` +
      `workspaceNotifyUserId() instead, or be added to ALLOWED with a reason:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the allowlist has not gone stale", () => {
    // Both directions: an allowlisted file that no longer reads the column is a
    // permission nobody needs, and it hides the next real offender.
    for (const [f, why] of ALLOWED) {
      expect(why.length, `${f} is allowlisted with no reason`).toBeGreaterThan(20);
      expect(readsRawOwner(strip(read(f))), `${f} is allowlisted but no longer reads the column — drop it`).toBe(true);
    }
  });
});

describe("team.delete refuses to remove the workspace owner", () => {
  const proc = windowBetween(
    strip(read("server/routers/admin.ts")),
    "  delete: adminWsProcedure",
    "  bulkChangeRole: adminWsProcedure",
    400,
  );

  it("compares the target against the owner column and throws", () => {
    /**
     * The sole-super_admin guard beside it protects the ROLE, not the OWNER
     * column — with a second super_admin present the owner was deletable, and
     * only transferOwnership ever rewrites that column.
     */
    /**
     * Pinned as a STATEMENT. An earlier version of this assertion matched only
     * `ownerRow.ownerUserId === target.userId`, and `if (false && ownerRow && …)`
     * walked straight through it — the same mutation this file warns about in
     * the SURFACES table, reproduced in the one describe block that had not
     * applied the rule. Caught by re-running the battery, not by reading it.
     */
    expect(proc).toMatch(/if \(ownerRow && ownerRow\.ownerUserId === target\.userId\) \{/);
    expect(proc).toMatch(/throw new TRPCError\(\{\s*code: "BAD_REQUEST",\s*message: "This member owns the workspace\./);
  });

  it("the comparison is fed by a real lookup, not a literal", () => {
    // The 8893dc8 trap: leaving the query in place but binding the result to a
    // constant keeps "the query exists" and "the check runs" both true.
    expect(proc).toMatch(/const \[ownerRow\] = await db\s*\.select\(\{ ownerUserId: workspaces\.ownerUserId \}\)/);
    expect(proc).toMatch(/\.where\(eq\(workspaces\.id, ctx\.workspace\.id\)\)/);
  });

  it("refuses BEFORE any of the destructive work", () => {
    const guardAt = proc.search(/ownerRow\.ownerUserId === target\.userId/);
    // Re-anchored when the three hand-written reassignments were consolidated
    // into @shared/ownedWork — there is no inline `UPDATE leads` any more.
    const reassignAt = proc.search(/await reassignOwnedWork\(/);
    expect(guardAt, "the owner guard is missing").toBeGreaterThan(-1);
    expect(reassignAt, "the reassignment is missing — re-anchor this test").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(reassignAt);
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
    expect(tableFiles.length).toBeGreaterThanOrEqual(11);
    for (const f of tableFiles) {
      expect(importsHelper(f), `${f} is in the table but does not import _core/activeMembers`).toBe(true);
    }
  });

  it("no file imports the gate without appearing in the table", () => {
    const consumers = globSourceFiles().filter(importsHelper);
    expect(consumers.length, "nothing imports the gate — the scan is broken").toBeGreaterThanOrEqual(11);
    for (const f of consumers) {
      expect(
        tableFiles,
        `${f} imports the membership gate but has no entry in SURFACES — add one naming the window it guards`,
      ).toContain(f);
    }
  });
});

/**
 * Does this source read `workspaces.ownerUserId` directly?
 *
 * The table is routinely imported under an alias — `workspaces as workspacesT`
 * in emailTracking.ts alone — so the binding is resolved from the file's own
 * import list rather than guessed. A hardcoded `workspacesT?` pattern was the
 * first version and a mutation importing it as anything else walked past it.
 *
 * 📌 BLIND SPOT, WRITTEN DOWN RATHER THAN PAPERED OVER: a read reached through
 * a local rebinding (`const t = workspaces; t.ownerUserId`) or a runtime
 * `await import()` destructure is not visible here. Static import aliases are,
 * which is the spelling every current file uses. A scanner that looks
 * exhaustive and isn't would be worse than one whose limit is stated.
 */
function readsRawOwner(strippedSrc: string): boolean {
  const names = new Set<string>(["workspaces"]);
  for (const m of strippedSrc.matchAll(/\bworkspaces\s+as\s+(\w+)/g)) names.add(m[1]!);
  for (const n of names) {
    if (new RegExp(`\\b${n}\\.ownerUserId\\b`).test(strippedSrc)) return true;
  }
  return false;
}

/**
 * Every .ts under server/, excluding tests.
 *
 * The helper itself is NOT excluded, and that was a real bug here: skipping it
 * made the raw-read scan below see one allowlisted file instead of two, and its
 * floor caught that rather than letting a half-blind scan report clean.
 */
function globSourceFiles(): string[] {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}
