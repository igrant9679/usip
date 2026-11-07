/**
 * First-party website visitor tracking.
 *
 *   GET  /v/track.js   — a tiny tracker script the customer embeds on their site.
 *   POST /api/track    — receives page views (public, CORS-open).
 *
 * The workspace slug is the public key (data-workspace="<slug>"). Visits that
 * carry a `vid` param — a lead/contact id in the link — are attributed to that
 * record. An id may be SIGNED (signVisitorId, audit 2026-10-20 P5): only a
 * signed id files a follow-up task, when the visit is to a high-intent page
 * (pricing/demo/contact). An unsigned id is a claim anyone can make, so its
 * visit is still recorded, and the visitors page calls it unverified (P88),
 * but it files nothing. Nothing in Velocity adds a signed id to outbound links
 * yet; that is the work left. This is the honest, provider-free half of the feature;
 * anonymous IP→company de-anonymization would need a paid IP-intelligence
 * vendor and is deliberately not stubbed.
 */
import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { and, eq, gte, like, sql } from "drizzle-orm";
import { getDb } from "./db";
import { activities, contacts, leads, tasks, websiteVisits, workspaces } from "../drizzle/schema";
import { pageIntent } from "@shared/pageIntent";
import { activeOwnerOrNull } from "./_core/activeMembers";
import { findSuppression, type SuppressionTarget } from "./services/suppression";

/**
 * Privacy (audit 2026-10-20, P87). A visitor whose browser sends Do Not Track
 * or Global Privacy Control is not tracked at all: no cookie, no beacon (and
 * the route drops a beacon that arrives with either header anyway). Only the
 * page's path is sent, never its query string or fragment, which carry search
 * terms, email addresses and campaign tokens; the referrer goes the same way.
 * The visitor cookie lasts VISITOR_COOKIE_DAYS, not a year.
 */
export const VISITOR_COOKIE_DAYS = 30;
/** How long a visit is kept; purgeOldWebsiteVisits runs daily (P87). */
export const WEBSITE_VISIT_RETENTION_DAYS = 180;

const TRACKER_JS = `(function(){try{
var n=navigator,w=window;
if(n.globalPrivacyControl===true||n.doNotTrack==='1'||n.doNotTrack==='yes'||w.doNotTrack==='1'||n.msDoNotTrack==='1')return;
var s=document.currentScript||(function(){var e=document.getElementsByTagName('script');return e[e.length-1];})();
var ws=s&&s.getAttribute('data-workspace');if(!ws)return;
var m=document.cookie.match(/(?:^|; )_vlvid=([^;]+)/);var vid=m?m[1]:(Date.now().toString(36)+Math.random().toString(36).slice(2,10));
if(!m){document.cookie='_vlvid='+vid+';path=/;max-age=${VISITOR_COOKIE_DAYS * 86400};SameSite=Lax';}
var q=new URLSearchParams(location.search);var known=q.get('vid')||q.get('vlid')||'';
var base=s.src.replace(/\\/v\\/track\\.js.*$/,'');
fetch(base+'/api/track',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({
slug:ws,visitorId:vid,path:location.pathname,referrer:(document.referrer||'').split(/[?#]/)[0],vid:known,ua:navigator.userAgent||''
})}).catch(function(){});
}catch(e){}})();`;

/** A URL or path without its query string or fragment — what is stored (P87). */
export function withoutQuery(value: unknown): string {
  return String(value ?? "").split(/[?#]/)[0];
}

/** The browser asked not to be tracked (Do Not Track or Global Privacy Control). */
export function optedOutOfTracking(header: (name: string) => string | undefined): boolean {
  return header("dnt") === "1" || header("sec-gpc") === "1";
}

/**
 * Delete visits older than WEBSITE_VISIT_RETENTION_DAYS, in batches so a first
 * run does not hold a long lock. Daily, with the engine-log retention in
 * _core/index.ts. Returns how many batches ran.
 */
export async function purgeOldWebsiteVisits(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(now.getTime() - WEBSITE_VISIT_RETENTION_DAYS * 86400000);
  let batches = 0;
  for (let i = 0; i < 200; i++) {
    const [res] = await db.execute(sql`DELETE FROM ${websiteVisits} WHERE ${websiteVisits.createdAt} < ${cutoff} LIMIT 5000`);
    batches++;
    if (Number((res as { affectedRows?: number })?.affectedRows ?? 0) < 5000) break;
  }
  return batches;
}

/*
 * `classifyIntent` lived here with its own patterns while chatPageContext.ts
 * carried a second copy under a comment claiming the two mirrored each other.
 * They did not: this one had no NON_BUYER band at all, so `/blog/pricing-guide`
 * scored HIGH and `/careers/product-manager` scored MEDIUM — and a HIGH visit by
 * a known contact SPAWNS A TASK for the record owner, so a blog reader
 * interrupted a rep. One definition now: @shared/pageIntent.
 */

/**
 * Confirm a claimed visitor identity actually belongs to the tracked workspace.
 *
 * Returns the ids that check out and nulls the ones that do not. Never throws:
 * a tracking beacon that starts failing is worse than one that records an
 * anonymous view.
 */
async function verifyVisitorIdentity(
  db: any,
  workspaceId: number,
  claimed: { contactId: number | null; leadId: number | null },
): Promise<{ contactId: number | null; leadId: number | null }> {
  const out = { contactId: null as number | null, leadId: null as number | null };
  try {
    if (claimed.contactId) {
      const [row] = await db.select({ id: contacts.id }).from(contacts)
        .where(and(eq(contacts.id, claimed.contactId), eq(contacts.workspaceId, workspaceId))).limit(1);
      if (row) out.contactId = row.id;
    }
    if (claimed.leadId) {
      const [row] = await db.select({ id: leads.id }).from(leads)
        .where(and(eq(leads.id, claimed.leadId), eq(leads.workspaceId, workspaceId))).limit(1);
      if (row) out.leadId = row.id;
    }
  } catch {
    return { contactId: null, leadId: null };
  }
  return out;
}

/** Parse a `vid` param of the form "c123" (contact) or "l456" (lead), or a bare number (lead), optionally signed ("l456.<sig>"). */
function parseVid(vid: string): { contactId: number | null; leadId: number | null } {
  const out = { contactId: null as number | null, leadId: null as number | null };
  if (!vid) return out;
  const m = /^([cl]?)(\d+)(?:\.[A-Za-z0-9_-]{16})?$/.exec(vid.trim());
  if (!m) return out;
  const n = Number(m[2]);
  if (!n) return out;
  if (m[1] === "c") out.contactId = n;
  else out.leadId = n; // default + "l" → lead
  return out;
}

/**
 * A link id the beacon can trust (audit 2026-10-20, P5): "l123.<sig>" or
 * "c123.<sig>", the signature an HMAC over the workspace and the id. Walking
 * sequential ids named a real record on every guess, and each named record
 * filed a high-priority task for its owner; a signed id can only come from
 * us. Bound to the workspace, so one tenant's id is nothing in another.
 */
function vidSecret(): string {
  const k = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || "";
  if (!k && process.env.NODE_ENV === "production") throw new Error("No server secret for visitor ids");
  return `visitor-id:${k || "dev-only"}`;
}
function vidSignature(workspaceId: number, base: string): string {
  return createHmac("sha256", vidSecret()).update(`${workspaceId}:${base}`).digest("base64url").slice(0, 16);
}
export function signVisitorId(workspaceId: number, kind: "c" | "l", id: number): string {
  const base = `${kind}${id}`;
  return `${base}.${vidSignature(workspaceId, base)}`;
}
/** True only for an id signed for THIS workspace. */
export function isSignedVid(workspaceId: number, vid: string): boolean {
  const m = /^([cl]\d+)\.([A-Za-z0-9_-]{16})$/.exec(String(vid ?? "").trim());
  if (!m) return false;
  const want = Buffer.from(vidSignature(workspaceId, m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * The most high-intent tasks the beacon may file for one workspace in a day.
 * Only a signed id files one now (P5), so this is a second fence: one task per
 * record per day is the other limit. Past this the visits keep counting and
 * the tasks stop (audit 2026-10-20, P5).
 */
export const MAX_INTENT_TASKS_PER_DAY = 50;

export function registerWebsiteTrackingRoutes(app: Express): void {
  // Serve the tracker script.
  app.get("/v/track.js", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(TRACKER_JS);
  });

  // CORS preflight for the cross-origin beacon.
  app.options("/api/track", (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
  });

  app.post("/api/track", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(202).json({ ok: true }); // ack fast; process below
    try {
      // An older cached copy of the script does not check DNT or GPC itself.
      if (optedOutOfTracking((name) => { const v = req.headers?.[name]; return Array.isArray(v) ? v[0] : v; })) return;
      const b: any = req.body ?? {};
      const slug: string = String(b.slug ?? "").trim();
      const visitorId: string = String(b.visitorId ?? "").slice(0, 64);
      // Stripped here too: an older cached script still sends the query string.
      const path: string = (withoutQuery(b.path ?? "/") || "/").slice(0, 1000);
      if (!slug || !visitorId) return;

      const db = await getDb();
      if (!db) return;
      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
      if (!ws) return;

      // ⚠️ `vid` arrives on a PUBLIC, unauthenticated beacon and used to be
      // trusted as-is. Any caller could POST slug=<workspace> with vid=c<id>
      // naming ANOTHER workspace's contact: the visit was stored attributed to
      // that foreign record, the Website Visitors page then joined it by id and
      // rendered their NAME AND COMPANY, and a high-intent visit spawned a task
      // pointing at their record id. Cross-tenant disclosure through a beacon
      // anyone can call.
      //
      // Verified against the tracked workspace here; an id that does not belong
      // to it is dropped and the visit is recorded ANONYMOUSLY rather than
      // rejected — the beacon must stay silent and keep counting page views.
      const claimed = parseVid(String(b.vid ?? ""));
      const { contactId, leadId } = await verifyVisitorIdentity(db, ws.id, claimed);
      // Only an id we signed can file a task (P5); an unsigned one is recorded and files nothing.
      const signed = isSignedVid(ws.id, String(b.vid ?? ""));
      const intent = pageIntent(path);

      await db.insert(websiteVisits).values({
        workspaceId: ws.id,
        visitorId,
        path,
        referrer: withoutQuery(b.referrer).slice(0, 1000) || null,
        contactId,
        leadId,
        intent,
        userAgent: String(b.ua ?? "").slice(0, 500) || null,
      } as never);

      // Autonomous intent signal: a KNOWN prospect on a high-intent page →
      // spawn one follow-up task/day (deduped) for the record owner. Dedup uses
      // prior high-intent visits for this record in the last 24h, so at most one
      // task fires per prospect per day regardless of page count.
      if (intent === "high" && (contactId || leadId) && signed) {
        const since = new Date(Date.now() - 86400000);
        const recCond = contactId ? eq(websiteVisits.contactId, contactId) : eq(websiteVisits.leadId, leadId as number);
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)` })
          .from(websiteVisits)
          .where(and(eq(websiteVisits.workspaceId, ws.id), eq(websiteVisits.intent, "high"), recCond, gte(websiteVisits.createdAt, since)));
        const [{ filed }] = await db
          .select({ filed: sql<number>`count(*)` })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, ws.id), like(tasks.title, "High-intent website visit:%"), gte(tasks.createdAt, since)));
        // count includes the row we just inserted; 1 ⇒ this is the first today.
        if (Number(n) <= 1 && Number(filed) < MAX_INTENT_TASKS_PER_DAY) {
          let name = "A known prospect";
          let ownerUserId: number | null = null;
          let target: SuppressionTarget = {};
          if (contactId) {
            const [c] = await db.select({ f: contacts.firstName, l: contacts.lastName, o: contacts.ownerUserId, email: contacts.email, linkedinUrl: contacts.linkedinUrl, companyDomain: contacts.companyDomain }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
            if (c) { name = `${c.f ?? ""} ${c.l ?? ""}`.trim() || name; ownerUserId = c.o ?? null; target = c; }
          } else if (leadId) {
            const [l] = await db.select({ f: leads.firstName, l: leads.lastName, o: leads.ownerUserId, email: leads.email }).from(leads).where(eq(leads.id, leadId)).limit(1);
            if (l) { name = `${l.f ?? ""} ${l.l ?? ""}`.trim() || name; ownerUserId = l.o ?? null; target = l; }
          }
          // No "reach out" task for someone who asked not to be contacted
          // (audit 2026-10-20, P87). A failed check files nothing either.
          const suppressed = await findSuppression(ws.id, target, "any").catch(() => "unchecked" as const);
          if (suppressed) return;
          await db.insert(tasks).values({
            workspaceId: ws.id,
            title: `High-intent website visit: ${name}`,
            // Only a signed link id reaches here (P5).
            description: `Viewed ${path} — reach out while intent is hot. The visit was matched by a signed id in the link.`,
            type: "follow_up",
            priority: "high",
            status: "open",
            dueAt: new Date(Date.now() + 3600000),
            // The record's stored owner may have left the workspace; a
            // time-sensitive task filed under a leaver dies unseen. Unowned
            // is claimable (see _core/activeMembers).
            ownerUserId: await activeOwnerOrNull(ws.id, ownerUserId),
            relatedType: contactId ? "contact" : "lead",
            relatedId: contactId ?? leadId,
            source: "ai",
          } as never);
          await db.insert(activities).values({
            workspaceId: ws.id,
            type: "system",
            relatedType: contactId ? "contact" : "lead",
            relatedId: contactId ?? leadId,
            subject: "High-intent website visit",
            body: `Viewed ${path}`,
          } as never);
        }
      }
    } catch (err) {
      console.error("[WebsiteTracking] /api/track error:", err);
    }
  });
}
