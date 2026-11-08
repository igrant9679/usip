/**
 * F47 (audit 2026-10-20; final pass 2026-11-07): public capture protection,
 * per-page conversion rates, and a booking's own reschedule-or-cancel page
 * with a calendar file.
 *
 *   1 · A form or landing-page submission needs the signed token its page was
 *       served with, at least three seconds old and under a day old. Missing,
 *       forged, moved or stale: "reload". Too quick: "press Submit again".
 *       The honeypot still answers bots with a silent success.
 *   2 · Cloudflare Turnstile only when a site key and a secret are both set
 *       (the workspace's own, stored encrypted, or the environment's). With
 *       none, nothing changes and nothing is sent to Cloudflare.
 *   3 · Landing pages and forms show a conversion rate; forms count views.
 *   4 · A booking gets its own page (/m/b/:token): reschedule to an open time,
 *       cancel, or save the .ics. The confirmation email links to it and
 *       carries the .ics; the calendar invite's text links to it. Nothing new
 *       is emailed by rescheduling or cancelling.
 *
 * Run against the SQL-evaluating fake. The calendar, the invite and the
 * confirmation email are mocked, and fetch is stubbed: nothing leaves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return {
    db: null as any,
    invites: [] as number[],
    confirmations: [] as any[],
    listEvents: async (): Promise<any[]> => [],
    deleted: [] as string[],
    moved: [] as Array<{ id: string; startAt: Date }>,
    fetches: [] as Array<{ url: string; body: string }>,
    verify: { success: true } as Record<string, unknown> | "throw",
  };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workflowEngine", () => ({ fireRecordCreated: async () => {} }));
vi.mock("./services/leadBridge", () => ({ bridgeLeadToRecords: async () => {} }));
vi.mock("./services/policyNotify", () => ({ notifyLeadRouted: async () => {} }));
vi.mock("./routers/leadScoring", async (a) => ({
  ...(await a<typeof import("./routers/leadScoring")>()),
  createTimeScore: async () => ({ total: 0 }),
  rescoreLead: async () => {},
}));
vi.mock("./services/meetingScheduler", async (a) => ({
  ...(await a<typeof import("./services/meetingScheduler")>()),
  sendMeetingInvite: async (_ws: number, meetingId: number, at: string) => { h.invites.push(meetingId); return { sent: false, scheduledAt: at, reason: "no_calendar_connected" }; },
}));
vi.mock("./services/bookingConfirmationEmail", async (a) => ({
  ...(await a<typeof import("./services/bookingConfirmationEmail")>()),
  sendBookingConfirmationEmail: async (input: any) => { h.confirmations.push(input); return { ok: true as const, fromEmail: "host@acme.example" }; },
}));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({
    listEvents: () => h.listEvents(),
    deleteEvent: async (_c: string, id: string) => { h.deleted.push(id); },
    updateEvent: async (_c: string, id: string, e: any) => { h.moved.push({ id, startAt: e.startAt }); return { externalId: id, ...e }; },
  }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import {
  CAPTURE_CHALLENGE, CAPTURE_STALE, CAPTURE_TOO_FAST, MIN_SUBMIT_MS, SUBMIT_TOKEN_MAX_AGE_MS, TURNSTILE_VERIFY_URL,
  checkSubmitToken, formScope, issueSubmitToken, landingScope, turnstileConfig,
} from "./services/publicCaptureGuard";
import { conversionRate } from "@shared/publicForm";
import { buildIcs, bookingIcsUid, icsEscape } from "@shared/ics";
import { bookingConfirmationBodies, bookingIcsAttachment } from "./services/bookingConfirmationEmail";
import { BOOKING_SLOT_BUSY, bookSlotForLink, openSlotsForLink } from "./routers/bookingLinks";
import { __resetCalendarFreeBusyCacheForTests } from "./services/calendarFreeBusy";
import { isPublicWritePath } from "./publicRateLimit";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2, ADMIN = 20, REP = 22;
const SEC = 1000;
const anon = () => appRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res: {} } as unknown as TrpcContext);
const admin = () => appRouter.createCaller({
  user: rows("users").find((u) => u.id === ADMIN),
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
const aged = (scope: string, ms = 10 * SEC) => issueSubmitToken(scope, Date.now() - ms);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.invites = [];
  h.confirmations = [];
  h.listEvents = async () => [];
  h.deleted = [];
  h.moved = [];
  h.fetches = [];
  h.verify = { success: true };
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  __resetCalendarFreeBusyCacheForTests();
  invalidateArchivedWorkspaceCache();
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    h.fetches.push({ url: String(url), body: String(init?.body ?? "") });
    if (h.verify === "throw") throw new Error("network down");
    return new Response(JSON.stringify(h.verify), { status: 200 });
  });
  rows("workspaces").push({ id: WS, name: "Acme", slug: "acme", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  rows("users").push(
    { id: ADMIN, openId: "local:20", name: "Admin", email: "admin@acme.example", role: "user", loginMethod: "password" },
    { id: REP, openId: "local:22", name: "Rep Host", email: "rep@acme.example", role: "user", loginMethod: "password" },
  );
  const member = (id: number, userId: number, role: string) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date() });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("forms").push({
    id: 80, workspaceId: WS, publicId: "pub80", title: "Contact", fields: [{ key: "email", label: "Email", required: true }], status: "active",
    redirectUrl: null, autoCreateLead: true, autoRoute: false, autoEnrollSequenceId: null, createdByUserId: ADMIN, submitCount: 0, viewCount: 0,
  });
  rows("landing_pages").push({
    id: 81, workspaceId: WS, slug: "spring", status: "published", autoCreateLead: true, autoRoute: false, autoEnrollSequenceId: null,
    createdByUserId: ADMIN, viewCount: 0, submitCount: 0, redirectUrl: null, formFields: [{ key: "email", label: "Email" }],
    headline: "Spring", themeColor: "#14B89A", formHeading: "Hi", ctaButtonLabel: "Go", showBookingCta: false, name: "Spring",
  });
});
afterEach(() => vi.unstubAllGlobals());

/* ── 1 · time to submit ───────────────────────────────────────────────── */

describe("a submission needs the token its page was served with (F47)", () => {
  it("the token checks out only for its own form, between three seconds and a day old", () => {
    const now = Date.now();
    const t = issueSubmitToken(formScope("pub80"), now);
    expect(checkSubmitToken(formScope("pub80"), t, now + MIN_SUBMIT_MS)).toBe("ok");
    expect(checkSubmitToken(formScope("pub80"), t, now + MIN_SUBMIT_MS - 1)).toBe("too_fast");
    expect(checkSubmitToken(formScope("pub80"), t, now + SUBMIT_TOKEN_MAX_AGE_MS + 1)).toBe("stale");
    expect(checkSubmitToken(formScope("other"), t, now + 10 * SEC)).toBe("invalid");
    expect(checkSubmitToken(landingScope("pub80"), t, now + 10 * SEC)).toBe("invalid");
    expect(checkSubmitToken(formScope("pub80"), `${(now - 60 * SEC).toString(36)}.${t.split(".")[1]}`, now)).toBe("invalid"); // re-dated
    expect(checkSubmitToken(formScope("pub80"), undefined, now)).toBe("missing");
    expect(checkSubmitToken(formScope("pub80"), "garbage", now)).toBe("invalid");
  });

  it("the page's read hands one out, and no Turnstile key when none is set up", async () => {
    const f = await anon().forms.getByPublicId({ publicId: "pub80" });
    expect(checkSubmitToken(formScope("pub80"), f!.submitToken, Date.now() + 4 * SEC)).toBe("ok");
    expect(f!.turnstileSiteKey).toBeNull();
    const p = await anon().landingPages.getBySlug({ slug: "spring" });
    expect(checkSubmitToken(landingScope("spring"), p.submitToken, Date.now() + 4 * SEC)).toBe("ok");
    expect(p.turnstileSiteKey).toBeNull();
  });

  it("no token, or a forged one: refused with 'reload', and nothing is kept", async () => {
    for (const submitToken of [undefined, "1.abc", aged(formScope("another-form"))]) {
      const r = await refusal(anon().forms.submit({ publicId: "pub80", data: { email: "vee@visitor.example" }, submitToken }));
      expect(r).toEqual({ code: "BAD_REQUEST", message: CAPTURE_STALE });
    }
    expect(rows("leads")).toHaveLength(0);
    expect(rows("form_submissions")).toHaveLength(0);
    expect(rows("forms")[0].submitCount).toBe(0);
  });

  it("too quick: told to press Submit again, nothing kept; the same visitor a moment later is captured", async () => {
    const r = await refusal(anon().forms.submit({ publicId: "pub80", data: { email: "vee@visitor.example" }, submitToken: aged(formScope("pub80"), 500) }));
    expect(r).toEqual({ code: "BAD_REQUEST", message: CAPTURE_TOO_FAST });
    expect(rows("leads")).toHaveLength(0);
    await anon().forms.submit({ publicId: "pub80", data: { email: "vee@visitor.example" }, submitToken: aged(formScope("pub80")) });
    expect(rows("leads")).toHaveLength(1);
    expect(rows("form_submissions")).toHaveLength(1);
  });

  it("landing pages the same", async () => {
    expect((await refusal(anon().landingPages.submit({ slug: "spring", data: { email: "b@visitor.example" } }))).message).toBe(CAPTURE_STALE);
    expect((await refusal(anon().landingPages.submit({ slug: "spring", data: { email: "b@visitor.example" }, submitToken: aged(landingScope("spring"), 100) }))).message).toBe(CAPTURE_TOO_FAST);
    expect(rows("landing_page_submissions")).toHaveLength(0);
    await anon().landingPages.submit({ slug: "spring", data: { email: "b@visitor.example" }, submitToken: aged(landingScope("spring")) });
    expect(rows("landing_page_submissions")).toHaveLength(1);
  });

  it("the honeypot still answers a bot with a silent success, token or not", async () => {
    const out = await anon().forms.submit({ publicId: "pub80", data: { email: "bot@spam.example", hp_website: "x" } });
    expect(out.ok).toBe(true);
    expect(rows("leads")).toHaveLength(0);
  });

  it("with no Turnstile configured nothing is sent to Cloudflare", async () => {
    await anon().forms.submit({ publicId: "pub80", data: { email: "vee@visitor.example" }, submitToken: aged(formScope("pub80")) });
    expect(h.fetches).toEqual([]);
  });
});

/* ── 2 · Turnstile, only when configured ──────────────────────────────── */

describe("Turnstile runs only with a site key and a secret (F47)", () => {
  const ok = () => ({ publicId: "pub80", data: { email: "vee@visitor.example" }, submitToken: aged(formScope("pub80")) });

  it("environment keys: the page gets the site key, a submission needs a passing answer", async () => {
    process.env.TURNSTILE_SITE_KEY = "site-test";
    process.env.TURNSTILE_SECRET_KEY = "secret-test";
    expect((await anon().forms.getByPublicId({ publicId: "pub80" }))!.turnstileSiteKey).toBe("site-test");
    expect((await refusal(anon().forms.submit(ok()))).message).toBe(CAPTURE_CHALLENGE);
    await anon().forms.submit({ ...ok(), turnstileToken: "widget-answer" });
    expect(rows("leads")).toHaveLength(1);
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]!.url).toBe(TURNSTILE_VERIFY_URL);
    const sent = new URLSearchParams(h.fetches[0]!.body);
    expect(sent.get("secret")).toBe("secret-test");
    expect(sent.get("response")).toBe("widget-answer");
  });

  it("a failing answer is refused; Cloudflare unreachable lets the person through", async () => {
    process.env.TURNSTILE_SITE_KEY = "site-test";
    process.env.TURNSTILE_SECRET_KEY = "secret-test";
    h.verify = { success: false };
    expect((await refusal(anon().forms.submit({ ...ok(), turnstileToken: "bad" }))).message).toBe(CAPTURE_CHALLENGE);
    expect(rows("leads")).toHaveLength(0);
    h.verify = "throw";
    await anon().forms.submit({ ...ok(), turnstileToken: "any" });
    expect(rows("leads")).toHaveLength(1);
  });

  it("half a pair is no pair", async () => {
    process.env.TURNSTILE_SITE_KEY = "site-test";
    expect(await turnstileConfig(WS)).toBeNull();
    expect((await anon().forms.getByPublicId({ publicId: "pub80" }))!.turnstileSiteKey).toBeNull();
  });

  it("the workspace's own pair, saved in Settings → Integrations, wins and its secret is stored encrypted", async () => {
    process.env.TURNSTILE_SITE_KEY = "site-env";
    process.env.TURNSTILE_SECRET_KEY = "secret-env";
    await admin().integrations.save({ provider: "turnstile", status: "connected", config: { siteKey: "site-ws", secretKey: "secret-ws" } });
    const stored = rows("workspace_integrations").find((r) => r.provider === "turnstile");
    expect(JSON.stringify(stored.config)).not.toContain("secret-ws");
    expect(stored.config.secretKeyEnc).toBeTruthy();
    expect(await turnstileConfig(WS)).toEqual({ siteKey: "site-ws", secret: "secret-ws", source: "workspace" });
    // The list any member can read shows that a secret is set, not the secret.
    const listed = (await admin().integrations.list()).find((r: any) => r.provider === "turnstile") as any;
    expect(listed.config).toEqual({ siteKey: "site-ws", hasSecretKey: true });
    // Saving again without retyping the secret keeps it.
    await admin().integrations.save({ provider: "turnstile", status: "connected", config: { siteKey: "site-ws2", secretKey: "" } });
    expect(await turnstileConfig(WS)).toEqual({ siteKey: "site-ws2", secret: "secret-ws", source: "workspace" });
  });
});

/* ── 3 · conversion rates ─────────────────────────────────────────────── */

describe("each capture page shows its conversion rate (F47)", () => {
  it("submissions over views, with the counts on hover and no rate when it can't be true", () => {
    expect(conversionRate(200, 9)).toEqual({ rate: 4.5, label: "4.5%", title: "9 submissions from 200 views" });
    expect(conversionRate(40, 10).label).toBe("25%");
    expect(conversionRate(10, 0).label).toBe("0%");
    expect(conversionRate(0, 0)).toMatchObject({ rate: null, label: "—", title: "No views yet" });
    expect(conversionRate(5, 7)).toMatchObject({ rate: null, label: "—" });
  });

  it("a form counts a view once per visitor per day", async () => {
    expect(await anon().forms.recordView({ publicId: "pub80", visitor: "v1" })).toEqual({ counted: true });
    expect(await anon().forms.recordView({ publicId: "pub80", visitor: "v1" })).toEqual({ counted: false });
    expect(await anon().forms.recordView({ publicId: "pub80", visitor: "v2" })).toEqual({ counted: true });
    expect(rows("forms")[0].viewCount).toBe(2);
    rows("forms")[0].status = "inactive";
    expect(await anon().forms.recordView({ publicId: "pub80", visitor: "v3" })).toEqual({ counted: false });
    expect(isPublicWritePath("/forms.recordView")).toBe(true);
  });

  it("the Landing Pages list and the Forms cards show the rate", () => {
    const lp = read("client/src/pages/usip/LandingPages.tsx");
    expect(lp).toContain("conversionRate(p.viewCount, p.submitCount).label} converted");
    const fv = read("client/src/pages/usip/FormsV2.tsx");
    expect(fv).toContain("conversionRate(f.viewCount, f.submitCount).label} converted");
    expect(read("client/src/pages/PublicForm.tsx")).toContain("recordView.mutate({ publicId, visitor: visitor || undefined })");
  });

  it("migrations 0380 and 0381 add the two columns, additive and nullable or defaulted", () => {
    const mig = read("server/_core/rawMigrations.ts");
    expect(mig).toContain('name: "0380_meeting_manage_token.sql"');
    expect(mig).toContain("ALTER TABLE `meetings` ADD COLUMN `manageToken` varchar(64) NULL");
    expect(mig).toContain("CREATE UNIQUE INDEX `ux_meetings_manage_token` ON `meetings` (`manageToken`)");
    expect(mig).toContain("ALTER TABLE `forms` ADD COLUMN `viewCount` int NOT NULL DEFAULT 0");
  });
});

/* ── 4 · a booking's own page ─────────────────────────────────────────── */

function seedLink() {
  rows("booking_links").push({
    id: 3, workspaceId: WS, userId: REP, slug: "rep-host-abcdefghij", title: "Intro call", description: null, durationMin: 30,
    active: true, bookingCount: 0, timezone: "UTC", startHour: 9, endHour: 17, workDays: "1,2,3,4,5",
  });
  return rows("booking_links")[0];
}

describe("a booking carries its own reschedule-or-cancel page and a calendar file (F47)", () => {
  it("the booking gets a 64-hex token; the invite text and the confirmation link to /m/b/<token>", async () => {
    const link = seedLink();
    const [slot] = await openSlotsForLink(link);
    const out = await anon().bookingLinks.book({ slug: link.slug, startAt: slot!, name: "Pat Booker", email: "pat@visitor.example" });
    const m = rows("meetings")[0];
    expect(m.manageToken).toMatch(/^[0-9a-f]{64}$/);
    expect(out.manageUrl).toMatch(new RegExp(`/m/b/${m.manageToken}$`));
    expect(out.icsUid).toBe(bookingIcsUid(WS, m.id));
    expect(m.inviteMessage).toBe(`Need to change this? Reschedule or cancel: ${out.manageUrl}`);
    expect(h.confirmations).toHaveLength(1);
    expect(h.confirmations[0].manageUrl).toBe(out.manageUrl);
  });

  it("the confirmation email links to the page and attaches the meeting as an .ics", () => {
    const start = new Date("2026-11-10T15:00:00Z");
    const b = bookingConfirmationBodies({
      title: "Intro call", startAt: start, durationMin: 30, timezone: "UTC", hostName: "Rep Host", contactName: "Pat",
      signature: "", unsubscribeUrl: "https://x.example/u", manageUrl: "https://app.example/m/b/abc",
    });
    expect(b.html).toContain('<a href="https://app.example/m/b/abc"');
    expect(b.text).toContain("Reschedule or cancel: https://app.example/m/b/abc");
    expect(b.text).toContain("reply to this email");
    const att = bookingIcsAttachment({ workspaceId: WS, meetingId: 7, title: "Intro call", startAt: start, durationMin: 30, hostName: "Rep Host", manageUrl: "https://app.example/m/b/abc" });
    expect(att.filename).toBe("invite.ics");
    expect(att.contentType).toContain("text/calendar");
    const ics = Buffer.from(att.content, "base64").toString("utf8");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("DTSTART:20261110T150000Z");
    expect(ics).toContain("DTEND:20261110T153000Z");
    expect(ics).toContain(`UID:${bookingIcsUid(WS, 7)}`);
    // Without a page (an old caller), the email reads as before.
    const plain = bookingConfirmationBodies({ title: "t", startAt: start, durationMin: 30, timezone: "UTC", hostName: "h", contactName: null, signature: "", unsubscribeUrl: "u" });
    expect(plain.text).toContain("If the time stops working, just reply to this email.");
    expect(plain.html).not.toContain("Reschedule or cancel");
  });

  it("sendBookingConfirmationEmail hands the .ics to the mailbox", () => {
    const src = read("server/services/bookingConfirmationEmail.ts");
    const send = src.slice(src.indexOf("await createEmailAdapter(account).sendEmail({"), src.indexOf("return { ok: true, fromEmail: account.fromEmail };"));
    expect(send).toContain("attachments: [bookingIcsAttachment(input)],");
  });

  it("the .ics escapes text and folds long lines", () => {
    expect(icsEscape("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const ics = buildIcs({ uid: "u1", title: "x".repeat(200), startAt: new Date("2026-11-10T15:00:00Z"), durationMin: 45 });
    for (const line of ics.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
    expect(ics).toContain("DTEND:20261110T154500Z");
  });

  async function booked() {
    const link = seedLink();
    const slots = await openSlotsForLink(link);
    await bookSlotForLink(link, { startAt: new Date(slots[0]!), name: "Pat Booker", email: "pat@visitor.example" });
    const m = rows("meetings")[0];
    h.invites = [];
    h.confirmations = [];
    rows("notifications").length = 0;
    __resetCalendarFreeBusyCacheForTests();
    return { link, m, slots, token: m.manageToken as string };
  }

  it("the page shows the meeting and the times it can move to; an unknown token is not found", async () => {
    const { token, slots } = await booked();
    const v = await anon().bookingLinks.manageGet({ token });
    expect(v).toMatchObject({ title: "Intro call", hostName: "Rep Host", state: "open", canReschedule: true, scheduledAt: slots[0] });
    expect(v.slots).not.toContain(slots[0]); // its own time is taken (by itself)
    expect(v.slots.length).toBeGreaterThan(10);
    expect((await refusal(anon().bookingLinks.manageGet({ token: "0".repeat(64) }))).code).toBe("NOT_FOUND");
  });

  it("cancel: the meeting closes, the host is told, and nothing is emailed or booked", async () => {
    const { token, m } = await booked();
    expect(await anon().bookingLinks.manageCancel({ token, reason: "Something came up" })).toEqual({ ok: true });
    expect(m.status).toBe("cancelled");
    expect(m.disposition).toBe("cancelled_by_booker");
    const n = rows("notifications");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ userId: REP, title: "Meeting cancelled: Pat Booker" });
    expect(n[0].body).toContain('Their note: "Something came up"');
    expect(h.confirmations).toEqual([]);
    expect(h.invites).toEqual([]);
    expect(await anon().bookingLinks.manageCancel({ token })).toEqual({ ok: true, already: true });
    expect((await anon().bookingLinks.manageGet({ token })).state).toBe("cancelled");
  });

  it("cancel deletes the provider event when the meeting is on the host's calendar", async () => {
    const { token, m } = await booked();
    rows("calendar_accounts").push({ id: 11, workspaceId: WS, userId: REP, provider: "outlook", calendarId: null, unipileAccountId: "acc" });
    rows("calendar_events").push({ id: 5, workspaceId: WS, userId: REP, calendarAccountId: 11, externalId: "evt-1", title: "Intro call", startAt: m.scheduledAt, endAt: m.scheduledAt, attendees: [] });
    m.calendarEventId = 5;
    m.calendarAccountId = 11;
    await anon().bookingLinks.manageCancel({ token });
    expect(h.deleted).toEqual(["evt-1"]);
    expect(rows("calendar_events")).toHaveLength(0);
  });

  it("reschedule: to another open time, re-arming the reminder and telling the host; nothing is emailed", async () => {
    const { token, m, slots } = await booked();
    m.reminderSentAt = new Date();
    const to = slots[5]!;
    expect(await anon().bookingLinks.manageReschedule({ token, startAt: to })).toEqual({ ok: true, scheduledAt: to });
    expect(new Date(m.scheduledAt).toISOString()).toBe(to);
    expect(m.status).toBe("rescheduled");
    expect(m.reminderSentAt).toBeNull();
    const n = rows("notifications");
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Meeting rescheduled: Pat Booker");
    expect(n[0].body).toContain("It is not on your calendar: add the new time by hand.");
    expect(h.confirmations).toEqual([]);
    expect(h.invites).toEqual([]);
  });

  it("reschedule refuses a time the page does not offer, and one the calendar now shows busy", async () => {
    const { token, m, slots } = await booked();
    const before = new Date(m.scheduledAt).toISOString();
    const r = await refusal(anon().bookingLinks.manageReschedule({ token, startAt: new Date("2026-11-08T03:00:00Z").toISOString() }));
    expect(r.code).toMatch(/CONFLICT|BAD_REQUEST/);
    rows("calendar_accounts").push({ id: 11, workspaceId: WS, userId: REP, provider: "outlook", calendarId: null, unipileAccountId: "acc" });
    await openSlotsForLink(rows("booking_links")[0]); // the cached list says slot 6 is free…
    h.listEvents = async () => [{ externalId: "x", title: "Busy", startAt: new Date(slots[6]!), endAt: new Date(Date.parse(slots[6]!) + 30 * 60_000), allDay: false, attendees: [] }];
    const r2 = await refusal(anon().bookingLinks.manageReschedule({ token, startAt: slots[6]! }));
    expect(r2).toEqual({ code: "CONFLICT", message: BOOKING_SLOT_BUSY });
    expect(new Date(m.scheduledAt).toISOString()).toBe(before);
  });

  it("a meeting that has happened can no longer be changed from the page", async () => {
    const { token, m } = await booked();
    m.scheduledAt = new Date(Date.now() - 3_600_000);
    expect((await anon().bookingLinks.manageGet({ token })).state).toBe("past");
    expect((await refusal(anon().bookingLinks.manageCancel({ token }))).code).toBe("CONFLICT");
  });

  it("reschedule and cancel are under the public write ceiling", () => {
    expect(isPublicWritePath("/bookingLinks.manageCancel")).toBe(true);
    expect(isPublicWritePath("/bookingLinks.manageReschedule")).toBe(true);
  });
});

/* ── the screens ──────────────────────────────────────────────────────── */

describe("the public pages wire it up (F47)", () => {
  it("the form and the landing page send the served token and draw Turnstile only when sent a site key", () => {
    for (const f of ["client/src/pages/PublicForm.tsx", "client/src/pages/LandingPage.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("const guard = useCaptureGuard(");
      expect(src, f).toContain("submitToken: guard.submitToken, turnstileToken: guard.turnstileToken");
      expect(src, f).toContain("{guard.widget}");
      expect(src, f).toContain("onError: () => guard.reset()");
      expect(src, f).toContain("refetchOnWindowFocus: false");
    }
    const g = read("client/src/components/usip/CaptureGuard.tsx");
    // The first token is kept: a refetch must not restart the clock.
    expect(g).toContain("if (!submitToken && served?.submitToken) setSubmitToken(served.submitToken);");
    expect(g).toContain("widget: siteKey ? <TurnstileWidget");
  });

  it("the booking's page is a lazy public route at /m/b/:token, and the booking page links to it with an .ics", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('const BookingManagePage = lazyChunk(() => import("@/pages/BookingManagePage"));');
    expect(app).toContain('<Route path="/m/b/:token"><BookingManagePage /></Route>');
    const page = read("client/src/pages/BookingManagePage.tsx");
    expect(page).toContain("trpc.bookingLinks.manageReschedule.useMutation");
    expect(page).toContain("trpc.bookingLinks.manageCancel.useMutation");
    expect(page).toContain("downloadIcs({");
    const booking = read("client/src/pages/BookingPage.tsx");
    expect(booking).toContain("Reschedule or cancel</a>");
    expect(booking).toContain("Add to calendar (.ics)");
  });
});
