/**
 * "Improve the open-tracking pixel and unsubscribe tracking to be more
 * accurate" (owner ask 2026-08-14).
 *
 * Both surfaces had the same defect in different clothes: a machine fetching a
 * URL was indistinguishable from a person acting on it.
 *
 *   • the OPEN PIXEL counted Apple Mail Privacy Protection (which fetches
 *     every remote image at delivery, for every Apple Mail recipient on the
 *     default setting) and corporate mail scanners as human opens — and on the
 *     ARE side the first such fetch fired the signal that runs an LLM and
 *     notifies the campaign owner that a prospect had "opened" the email;
 *
 *   • the UNSUBSCRIBE endpoint acted on a bare GET, so every mail-security
 *     scanner that follows links to check them (Proofpoint, Mimecast,
 *     Barracuda, Microsoft Safe Links) silently unsubscribed a recipient who
 *     had clicked nothing — permanently, with nothing recorded to say so.
 *
 * The classifier is pure and tested as such. The endpoint change is tested
 * structurally, because what matters is the ABSENCE of an action on a path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyOpen,
  isHumanProxy,
  PREFETCH_WINDOW_MS,
  DEDUPE_WINDOW_MS,
  MACHINE_USER_AGENTS,
  OPEN_MACHINE_REASONS,
} from "@shared/openTracking";
import { makeUnsubscribeUrl, unsubscribeHeaders } from "./unsubscribe";

const unsub = readFileSync("server/unsubscribe.ts", "utf8");
const tracking = readFileSync("server/emailTracking.ts", "utf8");
const migrations = readFileSync("server/_core/rawMigrations.ts", "utf8");

const APPLE_MAIL = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const HOUR = 60 * 60 * 1000;

describe("a pixel fetch is not an open until it looks like a person", () => {
  it("counts a normal client fetch well after the send", () => {
    const v = classifyOpen({ userAgent: APPLE_MAIL, method: "GET", msSinceSend: 3 * HOUR });
    expect(v.machine).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("rejects the delivery-time prefetch that Apple MPP produces", () => {
    // MPP presents an ordinary Safari user agent, so timing is the only tell
    // available from inside the request.
    const v = classifyOpen({ userAgent: APPLE_MAIL, method: "GET", msSinceSend: 900 });
    expect(v.machine).toBe(true);
    expect(v.reason).toBe("prefetch_window");
  });

  it("puts the boundary exactly where the constant says", () => {
    expect(classifyOpen({ userAgent: APPLE_MAIL, msSinceSend: PREFETCH_WINDOW_MS - 1 }).machine).toBe(true);
    expect(classifyOpen({ userAgent: APPLE_MAIL, msSinceSend: PREFETCH_WINDOW_MS }).machine).toBe(false);
  });

  it("rejects a HEAD probe", () => {
    // Express routes HEAD to the GET handler, so a scanner's probe counted as
    // an open without the image ever being loaded.
    const v = classifyOpen({ userAgent: APPLE_MAIL, method: "HEAD", msSinceSend: 3 * HOUR });
    expect(v.machine).toBe(true);
    expect(v.reason).toBe("head_probe");
  });

  it("rejects a fetch with no user agent at all", () => {
    expect(classifyOpen({ userAgent: "", msSinceSend: 3 * HOUR }).reason).toBe("no_user_agent");
    expect(classifyOpen({ msSinceSend: 3 * HOUR }).reason).toBe("no_user_agent");
  });

  it("rejects the mail-security scanners by name", () => {
    for (const ua of ["Proofpoint-Scanner/1.0", "Mimecast", "Barracuda Networks", "Microsoft Office SafeLinks"]) {
      const v = classifyOpen({ userAgent: ua, msSinceSend: 3 * HOUR });
      expect(v.machine, ua).toBe(true);
      expect(v.reason, ua).toBe("known_scanner");
    }
  });

  it("rejects scripted clients and headless browsers", () => {
    for (const ua of ["curl/8.4.0", "python-requests/2.31", "Go-http-client/2.0", "HeadlessChrome/120"]) {
      expect(classifyOpen({ userAgent: ua, msSinceSend: 3 * HOUR }).machine, ua).toBe(true);
    }
  });

  it("rejects generic bots on a word boundary, not a substring", () => {
    expect(classifyOpen({ userAgent: "SomeCrawler bot v2", msSinceSend: 3 * HOUR }).reason).toBe("bot_user_agent");
    // "Abbott" contains "bot" — a substring match would reject a real client.
    expect(classifyOpen({ userAgent: "Abbott Mail Client/3.1", msSinceSend: 3 * HOUR }).machine).toBe(false);
  });

  it("KEEPS the proxies that fetch because a human is looking", () => {
    // Gmail and Yahoo fetch through their proxies when the message is
    // DISPLAYED. Filtering them would delete most real Gmail opens — the
    // opposite error, and the bigger one.
    expect(isHumanProxy("Mozilla/5.0 (compatible; GoogleImageProxy)")).toBe(true);
    const v = classifyOpen({ userAgent: "Mozilla/5.0 (compatible; GoogleImageProxy)", msSinceSend: 3 * HOUR });
    expect(v.machine).toBe(false);
  });

  it("still calls a proxy fetch seconds after the send a prefetch", () => {
    const v = classifyOpen({ userAgent: "GoogleImageProxy", msSinceSend: 500 });
    expect(v.machine).toBe(true);
    expect(v.reason).toBe("prefetch_window");
  });

  it("collapses a fetch storm into one open", () => {
    const v = classifyOpen({ userAgent: APPLE_MAIL, msSinceSend: 3 * HOUR, msSinceLastOpen: DEDUPE_WINDOW_MS - 1 });
    expect(v.reason).toBe("duplicate_fetch");
    expect(classifyOpen({ userAgent: APPLE_MAIL, msSinceSend: 3 * HOUR, msSinceLastOpen: 5 * 60_000 }).machine).toBe(false);
  });

  it("counts the open when the send time is unknown rather than guessing", () => {
    // A row with no sentAt cannot be judged on timing; the fetch is not
    // discarded on a signal we do not have.
    expect(classifyOpen({ userAgent: APPLE_MAIL, msSinceSend: null }).machine).toBe(false);
  });

  it("gives every reason it can emit a human-readable label", () => {
    const emitted = ["head_probe", "no_user_agent", "known_scanner", "bot_user_agent", "duplicate_fetch", "prefetch_window"];
    for (const r of emitted) expect(OPEN_MACHINE_REASONS[r], r).toBeTruthy();
    expect(MACHINE_USER_AGENTS.length).toBeGreaterThan(20);
  });
});

describe("both open paths classify before they count", () => {
  it("the draft path counts machines separately and returns early", () => {
    const route = tracking.slice(tracking.indexOf('app.get("/api/track/open/:token"'));
    expect(route).toContain("classifyOpen(");
    expect(route).toContain("machineOpenCount");
    // openCount must not be reached by a machine fetch.
    const machineBranch = route.indexOf("if (verdict.machine)");
    const openCountBump = route.indexOf("openCount: sql`${emailDrafts.openCount} + 1`");
    expect(machineBranch).toBeGreaterThan(0);
    expect(openCountBump).toBeGreaterThan(machineBranch);
  });

  it("the ARE path does the same, and does not fire the signal on a machine", () => {
    const fn = tracking.slice(tracking.indexOf("async function recordAreOpen"), tracking.indexOf('app.get("/api/track/open/:token"'));
    expect(fn).toContain("classifyOpen(");
    const machineReturn = fn.indexOf("if (verdict.machine)");
    const signal = fn.indexOf("processSignal");
    expect(machineReturn).toBeGreaterThan(0);
    expect(signal).toBeGreaterThan(machineReturn);
  });

  it("records the raw event either way, with the verdict beside it", () => {
    // The classification has to be auditable against real user agents, or the
    // rule can never be corrected from data.
    expect((tracking.match(/isMachine: verdict\.machine/g) ?? []).length).toBe(2);
    expect((tracking.match(/machineReason: verdict\.reason/g) ?? []).length).toBe(2);
  });

  it("gives ARE opens an event row at all", () => {
    // They previously bumped a counter and recorded nothing about WHO fetched.
    const fn = tracking.slice(tracking.indexOf("async function recordAreOpen"), tracking.indexOf('app.get("/api/track/open/:token"'));
    expect(fn).toContain("executionQueueId: row.id");
  });
});

describe("unsubscribing takes a deliberate act", () => {
  it("GET asks and does not suppress", () => {
    const get = unsub.slice(unsub.indexOf('app.get("/api/unsubscribe/:token"'), unsub.indexOf('app.post("/api/unsubscribe/:token"'));
    expect(get).not.toContain("suppressIfNew");
    expect(get).toContain("CONFIRM_FORM_PAGE");
  });

  it("POST is what acts", () => {
    const post = unsub.slice(unsub.indexOf('app.post("/api/unsubscribe/:token"'));
    expect(post).toContain("suppressIfNew");
  });

  it("the form posts back to the same token", () => {
    expect(unsub).toContain('<form method="POST" action="/api/unsubscribe/');
  });

  it("distinguishes a mail client's one-click from a human confirming", () => {
    const post = unsub.slice(unsub.indexOf('app.post("/api/unsubscribe/:token"'));
    expect(post).toContain('"List-Unsubscribe"');
    expect(post).toContain("One-Click");
    expect(post).toContain("one_click_header");
    expect(post).toContain("link_confirmed");
  });

  it("records how every suppression arrived", () => {
    expect(unsub).toContain("source,");
    const m = migrations.slice(migrations.indexOf('name: "0165_open_tracking_accuracy.sql"'));
    expect(m.slice(0, m.indexOf("];"))).toContain("ALTER TABLE `email_suppressions` ADD COLUMN `source`");
  });
});

describe("the confirmation page is a promise about a row", () => {
  it("does not claim success when the write failed", () => {
    // It used to render the success page from the catch — "don't leak failures
    // into UX". Defensible for a cosmetic failure; not for a compliance act
    // whose failure the recipient discovers by continuing to receive mail.
    const post = unsub.slice(unsub.indexOf('app.post("/api/unsubscribe/:token"'));
    const catchBlock = post.slice(post.indexOf("} catch (err) {"));
    expect(catchBlock).toContain("FAILED_PAGE");
    expect(catchBlock).not.toContain("CONFIRM_PAGE");
    expect(catchBlock).toContain("status(500)");
  });

  it("refuses to conflate 'already on the list' with 'could not write'", () => {
    const fn = unsub.slice(unsub.indexOf("async function suppressIfNew"), unsub.indexOf("/** True if this email"));
    // Returning false for both is what let a dead database read as success.
    expect(fn).toContain('"added" | "already"');
    expect(fn).toContain("throw new Error");
    expect(fn).not.toMatch(/if \(!db\) return false/);
  });

  it("reads the suppression back before anyone is told it exists", () => {
    const fn = unsub.slice(unsub.indexOf("async function suppressIfNew"), unsub.indexOf("/** True if this email"));
    const insertAt = fn.indexOf("db.insert(emailSuppressions)");
    const verifyAt = fn.indexOf("await isSuppressed(");
    expect(insertAt).toBeGreaterThan(0);
    expect(verifyAt).toBeGreaterThan(insertAt);
    expect(fn).toContain("refusing to confirm it");
  });

  it("gives the recipient a route that does not depend on our database", () => {
    expect(unsub).toMatch(/reply to any message[\s\S]{0,80}unsubscribe/i);
  });
});

describe("RFC 8058 one-click headers", () => {
  it("emits both headers, and the URL matches the in-body link", () => {
    const h = unsubscribeHeaders("https://app.example.com", 4, "Dana@Acme.com");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Angle-bracketed per RFC 2369, and the same signed token the footer uses.
    expect(h["List-Unsubscribe"]).toBe(`<${makeUnsubscribeUrl("https://app.example.com", 4, "Dana@Acme.com")}>`);
    expect(h["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.com\/api\/unsubscribe\/.+>$/);
  });

  it("normalises the address the same way the endpoint will", () => {
    expect(unsubscribeHeaders("https://a.co", 2, "  Dana@Acme.com ")["List-Unsubscribe"])
      .toBe(unsubscribeHeaders("https://a.co", 2, "dana@acme.com")["List-Unsubscribe"]);
  });

  it("reaches the wire on the paths that already carry the footer", () => {
    const crm = readFileSync("server/routers/crm.ts", "utf8");
    const sequences = readFileSync("server/routers/sequences.ts", "utf8");
    expect((crm.match(/headers: unsubscribeHeaders\(/g) ?? []).length).toBe(2); // contact + lead
    expect(sequences).toContain("headers: unsubscribeHeaders(");
    // …and the adapters that can carry them do.
    const adapter = readFileSync("server/emailAdapter.ts", "utf8");
    expect(adapter).toContain("headers: input.headers,");        // SMTP
    expect(adapter).toContain("headers: input.headers ?? null,"); // SendGrid
    const sendgrid = readFileSync("server/services/sendgrid.ts", "utf8");
    expect(sendgrid).toContain("payload.headers");
  });
});

describe("migration 0165", () => {
  it("adds the columns both counters need", () => {
    const m = migrations.slice(migrations.indexOf('name: "0165_open_tracking_accuracy.sql"'));
    const block = m.slice(0, m.indexOf("];"));
    for (const frag of [
      "`email_tracking_events` MODIFY COLUMN `draftId` int NULL",
      "`email_tracking_events` ADD COLUMN `executionQueueId`",
      "`email_tracking_events` ADD COLUMN `isMachine`",
      "`email_drafts` ADD COLUMN `machineOpenCount`",
      "`are_execution_queue` ADD COLUMN `machineOpenCount`",
    ]) {
      expect(block, frag).toContain(frag);
    }
  });

  it("does not retroactively rewrite counts it cannot recompute", () => {
    // The historical openCount is a mix of humans and machines with no stored
    // user agent to re-decide from. Inventing a split would be worse than an
    // honest discontinuity.
    const m = migrations.slice(migrations.indexOf('name: "0165_open_tracking_accuracy.sql"'));
    const block = m.slice(0, m.indexOf("];"));
    expect(block).not.toContain("UPDATE `email_drafts` SET `openCount`");
    expect(block).not.toContain("UPDATE `are_execution_queue` SET `openCount`");
  });
});
