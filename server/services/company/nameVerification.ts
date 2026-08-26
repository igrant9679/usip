/**
 * Name verification — the background form of the owner's 08-26 directive:
 * "go to companies' websites to confirm the syntax of the company name…
 * for acronyms, find the full company name… run in the background whenever
 * a prospect is imported, scraped, or enriched sitewide."
 *
 * The safety model, in order of importance:
 *
 *  1. IDENTITY IS NEVER CHANGED. The sweep only offers a correction when the
 *     prospect's stored company string is a SLUG OF THE DOMAIN ITSELF
 *     ("Mncsf" @ mncsf.org, "Umn" @ umn.edu) — a string that carries no
 *     information beyond the domain, so replacing it with the domain's
 *     official name loses nothing. "Columbia University" next to a
 *     concern.net mailbox is untouched, exactly per the identity-source
 *     rule (a mailbox domain is not an employer).
 *  2. Writes go through fieldMerge as source `websiteOfficial` (88): a user
 *     pin (100) structurally survives, and any later stronger source can
 *     still correct us.
 *  3. The sweep finds work by scanning `prospects.updatedAt` inside a
 *     look-back window rather than by per-seam hooks — imports, scrapers,
 *     and enrichment all touch updatedAt, so every current AND future seam
 *     is covered without wiring any of them (the dead-wiring class).
 *  4. Lookups are cached per DOMAIN (workspace-independent), with honest
 *     terminal states: a parked/spam/error page is `unusable`, a fetch
 *     failure is `unreachable` and retried later — never "no name" (the
 *     failure-masking class).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { canonicalText } from "@shared/canonicalText";
import { getDb } from "../../db";
import { companyNameLookups, prospects } from "../../../drizzle/schema";
import { invokeLLM } from "../../_core/llm";
import {
  CONFIDENCE,
  mergeField,
  type FieldProvenance,
  type ProvenanceMap,
} from "../enrichment/fieldMerge";

/* ─── Pure helpers (unit-tested) ─────────────────────────────────────────── */

/** Personal-mailbox providers: their labels name the provider, never the org. */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "mail.com", "gmx.com", "gmx.net",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "mail.fm",
  "zoho.com", "fastmail.com", "hey.com",
]);

/** First label of a hostname ("gla.ac.uk" → "gla", "www.mncsf.org" → "mncsf"). */
export function domainLabel(domain: string): string | null {
  const host = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? parts[0] : null;
}

/** Is the stored company string just the domain's own label, case/punct-mangled? */
export function isSlugOfDomain(company: string, domain: string): boolean {
  const label = domainLabel(domain);
  if (!label) return false;
  // canonicalText spaces out punctuation; a domain label has no spaces, so
  // compare space-free ("10000 Degrees" ≡ "10000degrees").
  const squash = (s: string) => canonicalText(s).replace(/ /g, "");
  const c = squash(company);
  return c.length > 0 && c === squash(label);
}

/** The domain worth looking at for a prospect: stored companyDomain first,
 *  else the mailbox domain — but ONLY as a slug-detection hint, never as an
 *  identity source, and never a freemail provider. */
export function pickHintDomain(p: { companyDomain?: string | null; email?: string | null }): string | null {
  const cd = p.companyDomain ? String(p.companyDomain).trim().toLowerCase() : null;
  if (cd && !FREEMAIL_DOMAINS.has(cd)) return cd;
  const at = p.email?.indexOf("@") ?? -1;
  if (p.email && at > 0) {
    const ed = p.email.slice(at + 1).trim().toLowerCase();
    if (ed && !FREEMAIL_DOMAINS.has(ed)) return ed;
  }
  return null;
}

/** Refuse hosts a server-side fetch must never touch. */
export function isFetchableHost(domain: string): boolean {
  const host = String(domain).trim().toLowerCase().split("/")[0];
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (!host.includes(".")) return false;
  // IP literals: refuse outright (private ranges live here; org sites don't).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return true;
}

export interface PageSignals { title: string; siteName: string; appName: string; copyright: string; h1: string }

/** Pull the few strings a site uses to name itself. Bounded — never the page. */
export function extractSignals(html: string): PageSignals {
  const grab = (re: RegExp) => (html.match(re)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const title = grab(/<title[^>]*>([^<]{1,300})<\/title>/i);
  const siteName = grab(/property=["']og:site_name["'][^>]*content=["']([^"']{1,200})["']/i)
    || grab(/content=["']([^"']{1,200})["'][^>]*property=["']og:site_name["']/i);
  const appName = grab(/name=["']application-name["'][^>]*content=["']([^"']{1,200})["']/i);
  const copyright = grab(/(?:©|&copy;|&#169;|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*(?:by\s+)?([^<>\n|]{2,160})/i);
  const h1 = grab(/<h1[^>]*>(?:<[^>]+>)*([^<]{1,200})/i);
  return { title, siteName, appName, copyright, h1 };
}

/** "Federal Emergency Management Agency" + "FEMA" → "… (FEMA)"; no dup if
 *  the acronym already appears; bare-acronym officialName stays bare. */
export function composeDisplayName(officialName: string, acronym?: string | null): string {
  const name = officialName.trim().slice(0, 190);
  const acr = (acronym ?? "").trim();
  if (!acr || acr.length < 2) return name;
  if (name.toLowerCase().includes(acr.toLowerCase())) return name;
  return `${name} (${acr})`.slice(0, 200);
}

/* ─── Domain lookup (fetch + LLM extract, cached) ────────────────────────── */

const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNUSABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNREACHABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchHomepage(domain: string): Promise<string | null> {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; VelocityNameCheck/1.0)" },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("html")) continue;
      const text = await res.text();
      return text.slice(0, 300_000);
    } catch {
      // try the next variant; both failing means unreachable
    }
  }
  return null;
}

interface ExtractVerdict { usable: boolean; officialName: string; acronym: string | null; confidence: number; evidence: string }

async function extractOfficialName(domain: string, signals: PageSignals): Promise<ExtractVerdict> {
  const res = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You read how an organization names ITSELF on its own website and return the official display name. " +
          "Rules: the org's own branding wins (logo/title/og:site_name/copyright); strip page-title junk like 'Home |', "
          + "'Welcome to', taglines, and locations; preserve the org's own capitalization, punctuation, and diacritics exactly; "
          + "never append Inc./LLC unless the org itself brands with it. If the primary brand is an acronym or the site pairs "
          + "one with the full name, return the full name as officialName and the acronym separately. If the page is a parking "
          + "page, gambling/spam, a hosting error, or clearly not an organization's own site, return usable=false. "
          + "confidence: 0-100, how certain the signals identify the org's own name.",
      },
      {
        role: "user",
        content:
          `Domain: ${domain}\n` +
          `<title>: ${signals.title || "(none)"}\n` +
          `og:site_name: ${signals.siteName || "(none)"}\n` +
          `application-name: ${signals.appName || "(none)"}\n` +
          `copyright line: ${signals.copyright || "(none)"}\n` +
          `first h1: ${signals.h1 || "(none)"}`,
      },
    ],
    outputSchema: {
      name: "official_name",
      schema: {
        type: "object",
        properties: {
          usable: { type: "boolean" },
          officialName: { type: "string" },
          acronym: { type: ["string", "null"] },
          confidence: { type: "number" },
          evidence: { type: "string" },
        },
        required: ["usable", "officialName", "confidence"],
      },
    },
    max_tokens: 250,
  });
  const content = res.choices?.[0]?.message?.content;
  const parsed = JSON.parse(typeof content === "string" && content ? content : "{}");
  return {
    usable: parsed?.usable === true,
    officialName: String(parsed?.officialName ?? "").trim().slice(0, 200),
    acronym: parsed?.acronym ? String(parsed.acronym).trim().slice(0, 40) : null,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence ?? 0))),
    evidence: String(parsed?.evidence ?? "").trim().slice(0, 300),
  };
}

/** Cached official-name lookup for one domain. Returns the cache row. */
export async function lookupOfficialName(domain: string): Promise<{ status: string; officialName: string | null; acronym: string | null; confidence: number }> {
  const db = await getDb();
  if (!db) return { status: "unreachable", officialName: null, acronym: null, confidence: 0 };

  const [cached] = await db.select().from(companyNameLookups).where(eq(companyNameLookups.domain, domain)).limit(1);
  if (cached?.checkedAt) {
    const age = Date.now() - cached.checkedAt.getTime();
    const ttl = cached.status === "verified" ? VERIFIED_TTL_MS : cached.status === "unusable" ? UNUSABLE_TTL_MS : UNREACHABLE_TTL_MS;
    if (age < ttl) return { status: cached.status, officialName: cached.officialName, acronym: cached.acronym, confidence: cached.confidence };
  }

  let status = "unreachable";
  let officialName: string | null = null;
  let acronym: string | null = null;
  let confidence = 0;
  let evidence: string | null = null;

  if (isFetchableHost(domain)) {
    const html = await fetchHomepage(domain);
    if (html) {
      const signals = extractSignals(html);
      const hasSignal = signals.title || signals.siteName || signals.copyright || signals.h1;
      if (hasSignal) {
        try {
          const v = await extractOfficialName(domain, signals);
          if (v.usable && v.officialName) {
            status = "verified"; officialName = v.officialName; acronym = v.acronym; confidence = v.confidence; evidence = v.evidence;
          } else {
            status = "unusable"; evidence = v.evidence || "page not an org site";
          }
        } catch {
          status = "unreachable"; // LLM hiccup: retry window, not a verdict on the site
        }
      } else {
        status = "unusable"; evidence = "no naming signals in page";
      }
    }
  } else {
    status = "unusable"; evidence = "host not fetchable";
  }

  const now = new Date();
  if (cached) {
    await db.update(companyNameLookups)
      .set({ status, officialName, acronym, confidence, evidence, checkedAt: now, attempts: sql`${companyNameLookups.attempts} + 1` } as never)
      .where(eq(companyNameLookups.id, cached.id));
  } else {
    await db.insert(companyNameLookups)
      .values({ domain, status, officialName, acronym, confidence, evidence, checkedAt: now, attempts: 1 } as never);
  }
  return { status, officialName, acronym, confidence };
}

/* ─── The sweep ──────────────────────────────────────────────────────────── */

export interface NameVerificationResult {
  scanned: number; slugCandidates: number; domainsLookedUp: number;
  fixed: number; kept: number; unusableDomains: number;
}

const MIN_APPLY_CONFIDENCE = 70;

/**
 * Scan recently-touched prospects (all workspaces), find company strings that
 * are slugs of their own domain, resolve each domain's official name (cached),
 * and correct the display string through fieldMerge.
 */
export async function runNameVerificationSweep(opts?: {
  lookbackHours?: number; limit?: number; maxLookups?: number;
}): Promise<NameVerificationResult> {
  const out: NameVerificationResult = { scanned: 0, slugCandidates: 0, domainsLookedUp: 0, fixed: 0, kept: 0, unusableDomains: 0 };
  const db = await getDb();
  if (!db) return out;

  const lookbackHours = opts?.lookbackHours ?? 24;
  const limit = opts?.limit ?? 500;
  const maxLookups = opts?.maxLookups ?? 25;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: prospects.id, workspaceId: prospects.workspaceId, company: prospects.company,
      companyDomain: prospects.companyDomain, email: prospects.email, fieldProvenance: prospects.fieldProvenance,
    })
    .from(prospects)
    .where(gte(prospects.updatedAt, since))
    .orderBy(prospects.updatedAt)
    .limit(limit);
  out.scanned = rows.length;

  // Group slug candidates by domain so each domain is resolved once.
  const byDomain = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.company) continue;
    const dom = pickHintDomain(r);
    if (!dom || !isSlugOfDomain(r.company, dom)) continue;
    out.slugCandidates++;
    (byDomain.get(dom) ?? byDomain.set(dom, []).get(dom)!).push(r);
  }

  let lookups = 0;
  for (const [domain, group] of Array.from(byDomain.entries())) {
    if (lookups >= maxLookups) break; // the rest stays in the look-back window for the next tick
    lookups++;
    const lookup = await lookupOfficialName(domain);
    out.domainsLookedUp++;
    if (lookup.status !== "verified" || !lookup.officialName || lookup.confidence < MIN_APPLY_CONFIDENCE) {
      if (lookup.status === "unusable") out.unusableDomains++;
      continue;
    }
    const display = composeDisplayName(lookup.officialName, lookup.acronym);
    const at = new Date().toISOString();
    for (const p of group) {
      const ledger = { ...((p.fieldProvenance ?? {}) as ProvenanceMap) };
      const decision = mergeField(
        { value: p.company, provenance: ledger.company as FieldProvenance | undefined },
        { field: "company", value: display, source: "websiteOfficial", confidence: CONFIDENCE.websiteOfficial, at },
      );
      if (decision.action === "filled" || decision.action === "replaced" || decision.action === "corroborated") {
        ledger.company = decision.provenance;
        await db.update(prospects)
          .set({ company: decision.value, fieldProvenance: ledger } as never)
          .where(and(eq(prospects.id, p.id), eq(prospects.workspaceId, p.workspaceId)));
        if (decision.action !== "corroborated") out.fixed++;
      } else {
        out.kept++;
      }
    }
  }
  return out;
}
