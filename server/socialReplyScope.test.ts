/**
 * An autopilot may not act on a message from someone we never contacted.
 *
 * `unipile_messages` had `email_replies`' problem and none of its defences.
 * The messaging webhook stored EVERY inbound DM and handed each one straight
 * to the classifier, so on 2026-09-20 a recruiter's cold LinkedIn message was
 * classified like a campaign reply, counted on Home, counted in the social
 * funnel — and, if the model read it as "willing to meet", the rep's booking
 * link was DM'd back to a total stranger from the rep's own account.
 *
 * That is verbatim the failure services/replyScope.ts was written to stop on
 * email, recreated on the other channel. The contract now:
 *
 *   genuineSocialReplyScope()    the read half — derived in SQL, self-healing
 *   resolveSocialOutreachScope() the send half — decided once, FAILS CLOSED
 *   socialAutopilotMaySend()     an invite alone does not authorise a DM
 *
 * Source assertions: every path here is DB-backed, so a unit test would need
 * the very database this protects. Comments are stripped first — a guard a
 * comment can satisfy is not a guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Slice between two anchors, asserting BOTH were found. `indexOf` returning
 * −1 is how a scanner in this repo lies: `slice(a, -1)` is the whole file
 * minus one character, and every `toContain` on it passes for free.
 */
function windowBetween(src: string, startAnchor: string, endAnchor: string): string {
  const at = src.indexOf(startAnchor);
  expect(at, `start anchor not found — every assertion below would be meaningless: ${startAnchor}`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, at + startAnchor.length);
  expect(end, `end anchor not found after the start: ${endAnchor}`).toBeGreaterThan(at);
  const w = src.slice(at, end);
  expect(w.length, `window is too small to be the real block: ${startAnchor}`).toBeGreaterThan(120);
  return w;
}

/** One `app.post(...)` handler, bounded at the next one (webhookTenancy's technique). */
function handler(src: string, routePath: string): string {
  const at = src.indexOf(routePath);
  expect(at, `${routePath} not found`).toBeGreaterThan(0);
  const next = src.indexOf("app.post(", at + 1);
  return next > at ? src.slice(at, next) : src.slice(at);
}

const scope = strip(read("server/services/replyScope.ts"));
const webhook = strip(read("server/unipileWebhook.ts"));
const classifier = strip(read("server/services/replyClassifier.ts"));

describe("the shared social scope exists alongside the email one", () => {
  it("replyScope.ts exports both halves and the send gate", () => {
    for (const sym of [
      "export function genuineSocialReplyScope()",
      "export function notOurOutreachScope()",
      "export async function resolveSocialOutreachScope(",
      "export function socialAutopilotMaySend(",
    ]) {
      expect(scope).toContain(sym);
    }
  });

  it("the email half is untouched", () => {
    // The social half is an ADDITION. Rewriting the email definition while
    // adding a second one is how two surfaces start disagreeing again.
    expect(scope).toContain("or(isNotNull(emailReplies.draftId), isNotNull(emailReplies.campaignId))");
    expect(scope).toContain("GENUINE_REPLY_SQL");
  });

  it("the scope asks all three questions, and asks them per workspace", () => {
    const sql = windowBetween(scope, "const SOCIAL_SCOPE = sql`", "export function genuineSocialReplyScope");
    // chat, recipient provider id, invite — the three facts we already write.
    expect((sql.match(/exists \(select 1 from/g) ?? []).length).toBe(3);
    // Backticks are escaped in the template literal, so the source text of a
    // quoted identifier is \` … \`.
    expect(sql).toContain("\\`unipile_invites\\`");
    expect(sql).toContain("o2.\\`recipientProviderId\\`");
    // Multi-tenancy is not optional inside a correlated subquery either.
    expect((sql.match(/\\`workspaceId\\` = \\`unipile_messages\\`\.\\`workspaceId\\`/g) ?? []).length).toBe(3);
  });

  it("the resolver FAILS CLOSED — its last word is no outreach", () => {
    /**
     * Pinned as the LAST return, not as a presence. This value gates a send:
     * a transient DB error, an unmatched sender or a future early-exit must
     * all land on "we do not know them", never on a default tier.
     */
    const fn = windowBetween(scope, "export async function resolveSocialOutreachScope(", "export function socialAutopilotMaySend(");
    const returns = fn.match(/return [^;]*;/g) ?? [];
    expect(returns.length, "no returns found — re-anchor").toBeGreaterThan(2);
    expect(returns[returns.length - 1]).toBe("return NO_OUTREACH;");
    expect(scope).toContain("const NO_OUTREACH: SocialOutreach = { tier: null,");
    expect(fn).toContain("catch (e)");
  });

  it("an accepted invite alone does not authorise a DM", () => {
    // We have never written to that person: an unprompted booking link from
    // us is the cold outreach this whole scope refuses.
    const fn = windowBetween(scope, "export function socialAutopilotMaySend(", "\n}");
    expect(fn).toContain('tier === "chat" || tier === "recipient"');
    expect(fn).not.toContain('"invite"');
  });
});

describe("the messaging webhook decides scope before it acts", () => {
  const msgHook = handler(webhook, '"/api/unipile/messaging-webhook"');

  it("isolated the handler and did not run past it", () => {
    expect(msgHook.length).toBeGreaterThan(500);
    expect(msgHook).not.toContain("/api/unipile/users-webhook");
  });

  it("resolves scope, THEN stores, THEN classifies", () => {
    // Order is the guard. Resolving after the insert would match the row
    // against itself; classifying before the gate is the bug itself.
    const resolve = msgHook.indexOf("resolveSocialOutreachScope");
    const insert = msgHook.indexOf("db.insert(unipileMessages)");
    const classify = msgHook.indexOf("classifyAndHandleSocialMessage");
    expect(resolve, "the handler no longer resolves the outreach scope").toBeGreaterThan(0);
    expect(insert, "no insert found — has this handler changed?").toBeGreaterThan(0);
    expect(classify, "no classifier call found — has this handler changed?").toBeGreaterThan(0);
    expect(resolve).toBeLessThan(insert);
    expect(insert).toBeLessThan(classify);
  });

  it("stores the stranger's message anyway", () => {
    // Out of scope means "never acted on", never "never recorded": the rep
    // still reads it under Not our outreach.
    const gate = msgHook.indexOf("sc.tier &&");
    const insert = msgHook.indexOf("db.insert(unipileMessages)");
    expect(gate, "the autopilot block no longer requires an outreach tier").toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(insert);
  });

  it("carries the matched CRM linkage onto the inbound row", () => {
    // Without this the social meeting proposal is filed against nothing.
    expect(msgHook).toContain("linkedContactId: sc.linkedContactId");
    expect(msgHook).toContain("linkedLeadId: sc.linkedLeadId");
  });

  it("an archived workspace records but does not act", () => {
    const archive = msgHook.indexOf("archivedWs.has(");
    const insert = msgHook.indexOf("db.insert(unipileMessages)");
    const classify = msgHook.indexOf("classifyAndHandleSocialMessage");
    expect(archive, "no archive freeze — only the autopilot cron consulted it").toBeGreaterThan(0);
    expect(archive, "the freeze must not suppress the RECORD").toBeGreaterThan(insert);
    expect(archive, "the freeze must precede every action").toBeLessThan(classify);
  });

  it("the dedupe is per tenant", () => {
    // messageId is the PROVIDER's string, not ours, so an unscoped lookup let
    // one workspace's message suppress another's.
    const dedupe = windowBetween(msgHook, "const [dup]", "if (dup) return;");
    expect(dedupe).toContain("eq(unipileMessages.workspaceId, acct.workspaceId)");
  });
});

describe("the classifier refuses a conversation we did not start", () => {
  const social = windowBetween(classifier, "export async function classifyAndHandleSocialMessage(", "export async function runConversationAutopilotForWorkspace");

  it("the refusal comes before the model ever sees the message", () => {
    // Approval mode is no safeguard for this half: it gates the ACTION, not
    // the classification, so an ungated path still ships a stranger's private
    // DM to an LLM. Index comparison, so deleting the guard fails here.
    const guard = social.indexOf('if (!tier) return "out_of_scope";');
    const llm = social.indexOf("invokeLLM(");
    expect(guard, "the out-of-scope refusal is gone").toBeGreaterThan(-1);
    expect(llm, "no invokeLLM call — re-anchor").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(llm);
  });

  it("re-derives the tier when a caller omits it", () => {
    // Defence in depth: the webhook gates too, but one forgetful caller is all
    // it takes to DM a booking link to a stranger.
    expect(social).toContain("resolveSocialOutreachScope");
  });

  it("EVERY send site is gated, not just the one we know about", () => {
    /**
     * Per-site. A file-level `toContain("socialAutopilotMaySend")` is
     * satisfied by one gated send however many ungated siblings join it —
     * the weakness that let two ungated cron endpoints through (b15490d).
     */
    const ungated: string[] = [];
    let at = social.indexOf("sendMessage(");
    while (at > -1) {
      const head = social.slice(Math.max(0, at - 600), at);
      if (!head.includes("socialAutopilotMaySend(tier)")) ungated.push(social.slice(at, at + 80));
      at = social.indexOf("sendMessage(", at + 1);
    }
    expect(
      ungated,
      ungated.length
        ? `\n\nSocial send(s) with no outreach gate in the preceding condition:\n  ${ungated.join("\n  ")}\n\n` +
            `Every outbound DM from this function must sit behind\n` +
            `socialAutopilotMaySend(tier) — an inbound message is not permission\n` +
            `to write back to someone we never contacted.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the proposal and the task are not owned by a departed rep", () => {
    // This path names unipile_accounts.userId with no request context behind
    // it — the same hole createReplyTask closes for email.
    expect(social).toContain("const owner = await activeOwnerOrNull(workspaceId, ownerUserId);");
    expect(social).not.toContain("socialTask(db, workspaceId, msg, ownerUserId");
    expect(social).not.toContain("ownerUserId, relatedType");
  });
});

describe("the counters count replies to our outreach", () => {
  const conversations = strip(read("server/routers/conversations.ts"));
  const attention = strip(read("server/routers/attention.ts"));
  const unipile = strip(read("server/routers/unipile.ts"));

  it("Conversations scopes both the list and the header", () => {
    // The two must move together, or the header counts one population and the
    // rows show another — the trap the email half already fell into.
    expect((conversations.match(/genuineSocialReplyScope\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("Home's social queue is scoped", () => {
    expect((attention.match(/genuineSocialReplyScope\(\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("the social funnel scopes its inbound legs and counts meetings by the meeting", () => {
    const funnel = windowBetween(unipile, "socialFunnelStats: workspaceProcedure", "\n});");
    expect((funnel.match(/genuineSocialReplyScope\(\)/g) ?? []).length).toBe(2);
    // Was `autoActionTaken` = 'meeting_proposed', which silently dropped every
    // row whose action became 'booking_link_sent' — those DID book a meeting.
    expect(funnel).toContain("meetingId\\` is not null");
    expect(funnel).not.toContain("autoActionTaken\\` = 'meeting_proposed'");
  });

  it("the outbound 30d aggregates are left alone", () => {
    // They count what WE sent; scoping them would be a different (wrong) fix.
    const metrics = windowBetween(unipile, "metrics: workspaceProcedure", "socialFunnelStats: workspaceProcedure");
    expect(metrics).not.toContain("genuineSocialReplyScope");
  });
});

describe("out of scope is invisible to the counters, not to the rep", () => {
  const conversations = strip(read("server/routers/conversations.ts"));
  const page = read("client/src/pages/usip/ConversationsV2.tsx");

  it("the complement is reachable from the server", () => {
    expect(conversations).toContain("notOurOutreachScope()");
    expect(conversations).toContain('"not_our_outreach"');
  });

  it("a rep can still dismiss spam", () => {
    // Both mutations address ONE row by id; scoping them would leave a
    // stranger's DM permanently unhandleable.
    for (const anchor of ["markSocialHandled: repProcedure", "markSocialRead: repProcedure"]) {
      const w = windowBetween(conversations, anchor, "return { ok: true };");
      expect(w).not.toContain("SocialReplyScope");
      expect(w).not.toContain("notOurOutreachScope");
    }
  });

  it("the filter is offered on Social only", () => {
    // conversations.list's enum has no "not_our_outreach": offering it on the
    // Email tab sends an input tRPC rejects and the list errors out.
    expect(page).toContain("const SOCIAL_FILTERS");
    expect(page).toContain('value: "not_our_outreach"');
    expect(page).toContain("isEmail || isCalls ? FILTERS : SOCIAL_FILTERS");
  });
});

describe("the scope is derived, and indexed", () => {
  const migrations = read("server/_core/rawMigrations.ts");

  it("0183 adds the three indexes the EXISTS needs", () => {
    expect(migrations).toContain("0183_unipile_social_scope_indexes.sql");
    expect(migrations).toContain("ix_um_ws_chat");
    expect(migrations).toContain("ix_um_ws_recipient");
    expect(migrations).toContain("ix_ui_ws_recipient");
  });

  it("nothing is STAMPED on the row", () => {
    /**
     * Pins the decision, not just the code. A conversation can become ours
     * after the message lands (they DM'd first and the rep answers by hand; a
     * LinkedIn webhook arrives out of order) — a column written at insert time
     * is frozen wrong in exactly that case, and needs a backfill besides.
     */
    expect(migrations).not.toContain("`outreachScope`");
    expect(migrations).not.toContain("`outreachMessageId`");
  });
});
