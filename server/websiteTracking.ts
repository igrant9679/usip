/**
 * First-party website visitor tracking.
 *
 *   GET  /v/track.js   — a tiny tracker script the customer embeds on their site.
 *   POST /api/track    — receives page views (public, CORS-open).
 *
 * The workspace slug is the public key (data-workspace="<slug>"). Visits that
 * carry a `vid` param — a lead/contact id embedded in tracked outbound links
 * (e.g. sequence email CTAs) — are attributed to a KNOWN prospect. A high-intent
 * known visit (pricing/demo/contact pages) autonomously spawns a follow-up task
 * for the record owner. This is the honest, provider-free half of the feature;
 * anonymous IP→company de-anonymization would need a paid IP-intelligence
 * vendor and is deliberately not stubbed.
 */
import type { Express, Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { activities, contacts, leads, tasks, websiteVisits, workspaces } from "../drizzle/schema";

const TRACKER_JS = `(function(){try{
var s=document.currentScript||(function(){var e=document.getElementsByTagName('script');return e[e.length-1];})();
var ws=s&&s.getAttribute('data-workspace');if(!ws)return;
var m=document.cookie.match(/(?:^|; )_vlvid=([^;]+)/);var vid=m?m[1]:(Date.now().toString(36)+Math.random().toString(36).slice(2,10));
if(!m){document.cookie='_vlvid='+vid+';path=/;max-age=31536000;SameSite=Lax';}
var q=new URLSearchParams(location.search);var known=q.get('vid')||q.get('vlid')||'';
var base=s.src.replace(/\\/v\\/track\\.js.*$/,'');
fetch(base+'/api/track',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({
slug:ws,visitorId:vid,path:location.pathname+location.search,referrer:document.referrer||'',vid:known,ua:navigator.userAgent||''
})}).catch(function(){});
}catch(e){}})();`;

function classifyIntent(path: string): "low" | "medium" | "high" {
  const p = path.toLowerCase();
  if (/(pricing|demo|contact|book|trial|get-started|buy|checkout)/.test(p)) return "high";
  if (/(product|features|solutions|case-stud|customers|integrations)/.test(p)) return "medium";
  return "low";
}

/** Parse a `vid` param of the form "c123" (contact) or "l456" (lead), or a bare number (lead). */
function parseVid(vid: string): { contactId: number | null; leadId: number | null } {
  const out = { contactId: null as number | null, leadId: null as number | null };
  if (!vid) return out;
  const m = /^([cl]?)(\d+)$/.exec(vid.trim());
  if (!m) return out;
  const n = Number(m[2]);
  if (!n) return out;
  if (m[1] === "c") out.contactId = n;
  else out.leadId = n; // default + "l" → lead
  return out;
}

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
      const b: any = req.body ?? {};
      const slug: string = String(b.slug ?? "").trim();
      const visitorId: string = String(b.visitorId ?? "").slice(0, 64);
      const path: string = String(b.path ?? "/").slice(0, 1000);
      if (!slug || !visitorId) return;

      const db = await getDb();
      if (!db) return;
      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
      if (!ws) return;

      const { contactId, leadId } = parseVid(String(b.vid ?? ""));
      const intent = classifyIntent(path);

      await db.insert(websiteVisits).values({
        workspaceId: ws.id,
        visitorId,
        path,
        referrer: String(b.referrer ?? "").slice(0, 1000) || null,
        contactId,
        leadId,
        intent,
        userAgent: String(b.ua ?? "").slice(0, 500) || null,
      } as never);

      // Autonomous intent signal: a KNOWN prospect on a high-intent page →
      // spawn one follow-up task/day (deduped) for the record owner. Dedup uses
      // prior high-intent visits for this record in the last 24h, so at most one
      // task fires per prospect per day regardless of page count.
      if (intent === "high" && (contactId || leadId)) {
        const since = new Date(Date.now() - 86400000);
        const recCond = contactId ? eq(websiteVisits.contactId, contactId) : eq(websiteVisits.leadId, leadId as number);
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)` })
          .from(websiteVisits)
          .where(and(eq(websiteVisits.workspaceId, ws.id), eq(websiteVisits.intent, "high"), recCond, gte(websiteVisits.createdAt, since)));
        // count includes the row we just inserted; 1 ⇒ this is the first today.
        if (Number(n) <= 1) {
          let name = "A known prospect";
          let ownerUserId: number | null = null;
          if (contactId) {
            const [c] = await db.select({ f: contacts.firstName, l: contacts.lastName, o: contacts.ownerUserId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
            if (c) { name = `${c.f ?? ""} ${c.l ?? ""}`.trim() || name; ownerUserId = c.o ?? null; }
          } else if (leadId) {
            const [l] = await db.select({ f: leads.firstName, l: leads.lastName, o: leads.ownerUserId }).from(leads).where(eq(leads.id, leadId)).limit(1);
            if (l) { name = `${l.f ?? ""} ${l.l ?? ""}`.trim() || name; ownerUserId = l.o ?? null; }
          }
          await db.insert(tasks).values({
            workspaceId: ws.id,
            title: `High-intent website visit: ${name}`,
            description: `Viewed ${path} — reach out while intent is hot.`,
            type: "follow_up",
            priority: "high",
            status: "open",
            dueAt: new Date(Date.now() + 3600000),
            ownerUserId,
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
