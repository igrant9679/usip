/**
 * comprehensivePass — ONE enrichment event runs the whole funnel.
 *
 * Before this, each trigger ran only its own slice: the sweeper found
 * emails, the LinkedIn job read profiles, Apollo resolved domains inside
 * campaign flows — and nothing reconciled them. Now every trigger (manual
 * button, batch, sweeper row) calls THIS, which:
 *
 *   1. harvests candidates from every applicable source, cheapest first:
 *      existing LinkedIn profile data → Apollo name→domain → QuickEnrich
 *      (verified) → pattern+Reoon (verified) → site scrape (phone/socials);
 *   2. reconciles them field-by-field through fieldMerge (source quality,
 *      recency, cross-source agreement — never downgrading stronger data);
 *   3. persists winners + the provenance ledger (prospects.field_provenance)
 *      and stamps lastEnrichedAt;
 *   4. when the prospect has a LinkedIn URL but no profile data yet, queues
 *      the compliant LinkedIn job (async — its own caps and match review);
 *      that job's write-back flows through the same merge rules.
 *
 * Cost discipline is inherited, not reinvented: Apollo domain is free,
 * the MX gate inside the resolvers still guards Reoon spend, QuickEnrich
 * only bills on a hit, and the LinkedIn daily cap is enforced one layer
 * down in linkedinLookup.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, prospectLinkedinEnrichments } from "../../../drizzle/schema";
import { apolloResolveDomain } from "../apollo";
import { getQuickEnrichKey, quickenrichFindEmailByLinkedIn } from "../quickenrich";
import { getReoonKey, reoonVerifySingle, reoonStatusToUsip } from "../reoon";
import { resolveVerifiedEmail, lookupContactInfo } from "../scraper";
import {
  CONFIDENCE,
  mergeAll,
  type Candidate,
  type MergeDecision,
  type ProvenanceMap,
} from "./fieldMerge";

export interface ComprehensiveResult {
  ok: boolean;
  skipped?: "suppressed" | "not_found";
  phases: Record<string, string>;
  decisions: MergeDecision[];
  queuedLinkedInJob: number | null;
  email: string | null;
  emailStatus: string | null;
  /** Reoon spend this pass — the sweeper's budget accounting reads this. */
  credits: { quick: number; power: number };
}

function emailConfidence(verification: string | null | undefined, base: number): { conf: number; verification?: string } {
  switch (verification) {
    case "valid": return { conf: base, verification };
    case "accept_all": return { conf: CONFIDENCE.emailAcceptAll, verification };
    case "risky": return { conf: CONFIDENCE.emailRisky, verification };
    case "invalid": return { conf: 0, verification };
    default: return { conf: CONFIDENCE.emailUnknown, verification: verification ?? undefined };
  }
}

export async function runComprehensiveEnrichment(opts: {
  workspaceId: number;
  prospectId: number;
  /** Who triggered it — threaded into the queued LinkedIn job. */
  userId: number;
  isAdmin?: boolean;
  trigger: string;
  /** Bulk callers (sweeper) set false: one sweep must not spawn N jobs. */
  queueLinkedInJob?: boolean;
}): Promise<ComprehensiveResult> {
  const phases: Record<string, string> = {};
  const credits = { quick: 0, power: 0 };
  const now = new Date().toISOString();
  const db = await getDb();
  if (!db) return { ok: false, skipped: "not_found", phases, decisions: [], queuedLinkedInJob: null, email: null, emailStatus: null, credits };

  const [p] = await db.select().from(prospects)
    .where(and(eq(prospects.workspaceId, opts.workspaceId), eq(prospects.id, opts.prospectId)))
    .limit(1);
  if (!p) return { ok: false, skipped: "not_found", phases, decisions: [], queuedLinkedInJob: null, email: null, emailStatus: null, credits };
  // Same compliance rule as the LinkedIn path: a rejected/suppressed
  // prospect is not enriched by ANY source.
  if (p.verificationStatus === "rejected") {
    return { ok: false, skipped: "suppressed", phases, decisions: [], queuedLinkedInJob: null, email: p.email, emailStatus: p.emailStatus, credits };
  }

  const candidates: Candidate[] = [];

  /* ── 1. LinkedIn profile — retrieved IN this pass when triggered on a
     single prospect. The earlier design queued an async job whose match
     review could park the result unapplied, so the pass finished with a
     catch-all email and STILL no company or photo (the owner's report).
     A user pointing at one specific person is identity confirmation —
     the same semantics as confirmEnrich — so retrieve + apply now, photo
     included. Bulk callers (sweep/batch) still skip: 25 rows must not
     drain the 100/day LinkedIn cap. ─────────────────────────────────── */
  const loadEnrichment = async () => {
    const [row] = await db.select().from(prospectLinkedinEnrichments)
      .where(and(
        eq(prospectLinkedinEnrichments.workspaceId, opts.workspaceId),
        eq(prospectLinkedinEnrichments.prospectId, opts.prospectId),
      ))
      .limit(1);
    return row ?? null;
  };
  let enr = await loadEnrichment();
  const enrIsFresh =
    enr?.linkedinDataStatus === "enriched" &&
    enr.linkedinLastRetrievedAt &&
    Date.now() - new Date(enr.linkedinLastRetrievedAt).getTime() < 30 * 86_400_000;

  if (!enrIsFresh && opts.queueLinkedInJob !== false) {
    try {
      const { determineLookupStrategy } = await import("../linkedinEnrichment/lookupStrategy");
      const { retrieveLinkedInProfileByUrl, retrieveByNameCompany } = await import("../linkedinEnrichment/unipileProfile");
      const { scoreIntendedMatch } = await import("../linkedinEnrichment/matching");
      const { applyEnrichment } = await import("../linkedinEnrichment/enrichmentService");
      const { strategy, url } = determineLookupStrategy(p as never, enr?.linkedinProfileUrl ?? null);
      if (strategy !== "unavailable") {
        const retrieve = url
          ? await retrieveLinkedInProfileByUrl({ workspaceId: opts.workspaceId, userId: opts.userId, isAdmin: opts.isAdmin ?? false, linkedinUrl: url })
          : await retrieveByNameCompany({ workspaceId: opts.workspaceId, userId: opts.userId, isAdmin: opts.isAdmin ?? false, prospect: p as never });
        if (retrieve.ok && retrieve.profile) {
          const match = scoreIntendedMatch(p as never, retrieve.profile, { userInitiatedSingle: true });
          await applyEnrichment({
            workspaceId: opts.workspaceId, prospectId: opts.prospectId,
            profile: retrieve.profile, matchStatus: match.status,
            sourceAccountId: retrieve.viaAccountId,
            imageAllowed: !!retrieve.profile.profileImageUrl,
          });
          enr = await loadEnrichment();
          phases.linkedinRetrieve = retrieve.profile.profileImageUrl
            ? "profile retrieved + applied (photo included)"
            : "profile retrieved + applied (no photo on profile)";
        } else {
          phases.linkedinRetrieve = `retrieve failed (${(retrieve.message ?? "unknown").slice(0, 80)})`;
        }
      } else {
        phases.linkedinRetrieve = "no URL and not enough context to look up";
      }
    } catch (e) {
      phases.linkedinRetrieve = `unavailable (${e instanceof Error ? e.message.slice(0, 80) : "error"})`;
    }
  }

  if (enr && enr.linkedinDataStatus === "enriched") {
    const at = (enr.linkedinLastRetrievedAt ?? new Date(0)).toISOString();
    const li = (field: Candidate["field"], value: string | null | undefined) => {
      if (value?.trim()) candidates.push({ field, value: value.trim(), source: "linkedin", confidence: CONFIDENCE.linkedinProfile, at });
    };
    li("company", enr.currentCompanyName);
    li("companyDomain", enr.currentCompanyDomain);
    li("title", enr.currentTitle);
    // First (most recent) education entry, defensively across shapes.
    const edu = Array.isArray(enr.educationHistoryJson) ? (enr.educationHistoryJson as Array<Record<string, unknown>>)[0] : null;
    const school = edu && (edu.school ?? edu.schoolName ?? edu.name);
    if (typeof school === "string") li("education", school);
    phases.linkedin = "used existing profile data";
  } else {
    phases.linkedin = enr ? `profile ${enr.linkedinDataStatus}` : "no profile data yet";
  }

  /* ── 2. Company name → domain (free) ──────────────────────────────── */
  const companyName = (candidates.find((c) => c.field === "company")?.value ?? p.company ?? "").trim();
  const haveDomain = !!(p.companyDomain?.trim() || candidates.some((c) => c.field === "companyDomain"));
  if (!haveDomain && companyName) {
    const r = await apolloResolveDomain(opts.workspaceId, companyName);
    if (r.domain) {
      candidates.push({ field: "companyDomain", value: r.domain, source: "apollo", confidence: CONFIDENCE.apolloDomain, at: now });
      phases.domain = `resolved ${r.domain}`;
    } else {
      phases.domain = `no domain (${r.error ?? "no match"})`;
    }
  } else {
    phases.domain = haveDomain ? "already known" : "no company name to resolve";
  }

  /* ── 3. Email — only while we don't hold a Reoon-valid address ────── */
  const emailIsProven = !!p.email && p.emailStatus === "valid";
  const bestDomain = (candidates.find((c) => c.field === "companyDomain")?.value ?? p.companyDomain ?? "").trim() || null;

  if (!emailIsProven) {
    // 3a. QuickEnrich (LinkedIn-keyed database; bills only on a hit).
    const qeKey = await getQuickEnrichKey(opts.workspaceId).catch(() => "");
    if (qeKey && p.linkedinUrl) {
      const hit = await quickenrichFindEmailByLinkedIn(qeKey, p.linkedinUrl);
      if (hit.email) {
        let verification: string | undefined;
        try {
          const reoonKey = await getReoonKey(opts.workspaceId);
          if (reoonKey) { verification = reoonStatusToUsip((await reoonVerifySingle(hit.email, reoonKey, "power")).status); credits.power += 1; }
        } catch { /* verification unavailable — candidate carries no verdict */ }
        const { conf, verification: v } = emailConfidence(verification, CONFIDENCE.quickenrichVerified);
        if (conf > 0) {
          candidates.push({ field: "email", value: hit.email, source: "quickenrich", confidence: conf, at: now, ...(v ? { verification: v } : {}) });
          phases.quickenrich = `found (${v ?? "unverified"})`;
        } else {
          phases.quickenrich = "hit failed verification";
        }
      } else {
        phases.quickenrich = `miss (${hit.reason})`;
      }
    } else {
      phases.quickenrich = qeKey ? "no LinkedIn URL" : "no key";
    }

    // 3b. Pattern + Reoon (pure resolver; MX gate lives inside it).
    if (bestDomain && !candidates.some((c) => c.field === "email" && c.verification === "valid")) {
      const found = await resolveVerifiedEmail({
        firstName: p.firstName, lastName: p.lastName,
        companyDomain: bestDomain, workspaceId: opts.workspaceId,
      });
      credits.quick += found.creditsQuick ?? 0;
      credits.power += found.creditsPower ?? 0;
      if (found.email) {
        const { conf, verification: v } = emailConfidence(found.status, CONFIDENCE.patternReoonValid);
        if (conf > 0) {
          candidates.push({ field: "email", value: found.email, source: "pattern_reoon", confidence: conf, at: now, ...(v ? { verification: v } : {}) });
        }
        phases.pattern = `found (${found.status ?? "unknown"})`;
      } else {
        phases.pattern = `miss (${found.reason ?? "none"})`;
      }
    } else if (!bestDomain) {
      phases.pattern = "no domain";
    } else {
      phases.pattern = "skipped — verified email already found this pass";
    }
  } else {
    phases.quickenrich = phases.pattern = "skipped — email already verified";
  }

  /* ── 4. Site scrape for phone/socials (first time only) ───────────── */
  if (bestDomain && (!p.phone || !p.enrichmentData)) {
    // lookupContactInfo persists the scrape itself (phone fill-if-empty,
    // enrichmentData always); skipIfHasEmail keeps ITS email write out of
    // the way — email decisions belong to the merge below.
    const scraped = await lookupContactInfo({
      workspaceId: opts.workspaceId, prospectId: opts.prospectId,
      firstName: p.firstName, lastName: p.lastName,
      companyDomain: bestDomain, skipIfHasEmail: true, existingPhone: p.phone,
    }).catch((e) => { phases.scrape = `failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`; return null; });
    if (scraped) {
      credits.quick += scraped.reoonCreditsQuick ?? 0;
      credits.power += scraped.reoonCreditsPower ?? 0;
      if (scraped.phone && !p.phone) {
        candidates.push({ field: "phone", value: scraped.phone, source: "site_scrape", confidence: CONFIDENCE.scrapeFound, at: now });
      }
      phases.scrape = scraped.phone ? "phone found" : "no phone";
    }
  } else {
    phases.scrape = !bestDomain ? "no domain" : "already scraped";
  }

  /* ── 4b. Company name from the domain root — the last-resort deriver.
     A prospect can reach here with a found email and STILL no company
     name (nothing on file, no LinkedIn data, Apollo needs a name to
     search BY). "acme-corp.com" → "Acme Corp" at low confidence: it
     fills the blank honestly (the ledger says domain_derived · 40) and
     any real source replaces it on the next pass. ──────────────────── */
  const hasCompanyCandidate = candidates.some((c) => c.field === "company") || !!p.company?.trim();
  if (!hasCompanyCandidate && bestDomain) {
    const root = bestDomain.split(".")[0]?.replace(/[-_]+/g, " ").trim();
    if (root && root.length >= 3 && !/^\d+$/.test(root)) {
      const derived = root.replace(/\b\w/g, (ch) => ch.toUpperCase());
      candidates.push({ field: "company", value: derived, source: "domain_derived", confidence: 40, at: now });
      phases.companyName = `derived "${derived}" from domain`;
    }
  }

  /* ── 5. Reconcile + persist ───────────────────────────────────────── */
  const merged = mergeAll(
    {
      email: p.email, phone: p.phone, company: p.company,
      companyDomain: p.companyDomain, title: p.title,
      education: p.education, linkedinUrl: p.linkedinUrl,
    },
    (p.fieldProvenance ?? {}) as ProvenanceMap,
    candidates,
  );

  const patch: Record<string, unknown> = { fieldProvenance: merged.ledger, lastEnrichedAt: new Date() };
  for (const [field, value] of Object.entries(merged.fields)) {
    patch[field] = field === "title" ? value.slice(0, 120) : value.slice(0, field === "email" ? 320 : 200);
  }
  const emailDecision = merged.decisions.find((d) => d.field === "email" && (d.action === "filled" || d.action === "replaced"));
  if (emailDecision?.provenance.verification) {
    patch.emailStatus = emailDecision.provenance.verification;
    patch.emailVerifiedAt = new Date();
  }
  await db.update(prospects).set(patch as never)
    .where(and(eq(prospects.workspaceId, opts.workspaceId), eq(prospects.id, opts.prospectId)));

  /* ── 6. Queue the compliant LinkedIn job when profile data is absent ─ */
  let queuedLinkedInJob: number | null = null;
  if (opts.queueLinkedInJob !== false && p.linkedinUrl && (!enr || enr.linkedinDataStatus !== "enriched")) {
    try {
      const { runForProspects } = await import("../linkedinEnrichment/orchestrator");
      const job = await runForProspects({
        workspaceId: opts.workspaceId, userId: opts.userId, isAdmin: opts.isAdmin ?? false,
        prospectIds: [opts.prospectId], triggerType: "people_bulk_action",
      } as never);
      queuedLinkedInJob = (job as { jobId?: number }).jobId ?? null;
      phases.linkedinJob = "queued profile lookup";
    } catch (e) {
      phases.linkedinJob = `not queued (${e instanceof Error ? e.message.slice(0, 80) : "error"})`;
    }
  }

  const finalEmail = (merged.fields.email as string | undefined) ?? p.email;
  return {
    ok: true,
    phases,
    decisions: merged.decisions,
    queuedLinkedInJob,
    email: finalEmail ?? null,
    emailStatus: (patch.emailStatus as string | undefined) ?? p.emailStatus ?? null,
    credits,
  };
}
