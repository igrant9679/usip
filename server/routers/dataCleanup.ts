/**
 * Data cleanup — repair contact records from data the workspace already has.
 *
 * Built after two findings on live data:
 *   • ALL 1,520 contacts have email = null, so the importer's email-based
 *     duplicate detection can never fire, and none of them can be emailed.
 *   • 756 have a URL in `companyName` (e.g. "https://facebook.com/mongodb")
 *     rather than a company name — a mis-mapped column from an earlier import.
 *
 * NON-NEGOTIABLE RULES, because this mutates real CRM records in bulk:
 *   1. Emails are only ever copied from a linked prospect_queue row. An email
 *      address is NEVER derived, guessed, or pattern-generated. A fabricated
 *      address means mail to a stranger and a burnt sending domain.
 *   2. Nothing good is overwritten. A contact that already has an email keeps
 *      it; a companyName that isn't a URL is left exactly as-is.
 *   3. dryRun defaults to TRUE. Callers must ask explicitly to write.
 *   4. Every run reports what it did AND what it could not fix, so the
 *      remaining gap is never hidden by a success message.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { router } from "../_core/trpc";
import { adminWsProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { accounts, contacts, prospectQueue } from "../../drizzle/schema";

/** Hosts that identify a social/profile site, never the company's own domain. */
const SOCIAL_HOST = /(facebook|linkedin|twitter|instagram|youtube|crunchbase|x)\.com$/i;

/**
 * The company's own domain from a URL — or null when the URL is a social
 * profile.
 *
 * Caught by the first dry run: preserving the host blindly would have written
 * companyDomain="facebook.com" onto 756 contacts. A wrong domain is worse than
 * an empty one — it would poison company matching, account linking, and any
 * future email-pattern enrichment.
 */
export function companyDomainFromUrl(url?: string | null): string | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  const host = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.toLowerCase();
  if (!host || !host.includes(".")) return null;
  if (SOCIAL_HOST.test(host)) return null;
  return host.slice(0, 200);
}

/** Does this look like a URL rather than a company name? */
export function looksLikeUrl(value?: string | null): boolean {
  const s = (value ?? "").trim();
  if (!s) return false;
  return /^https?:\/\//i.test(s) || /^www\./i.test(s) || /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(s);
}

/**
 * Best-effort company name from a profile URL, used only when no better source
 * exists. "https://facebook.com/mongodb" → "mongodb".
 *
 * Deliberately does NOT try to fix capitalisation ("mongodb" is not turned into
 * "MongoDB"): guessing casing invents information. A lowercase slug is honest
 * and still far more useful for matching than a full URL.
 */
export function companyFromUrl(url?: string | null): string | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  // Social profile URLs carry the company in the PATH; a bare domain carries it
  // in the host. Both appear in this data.
  const SOCIAL = /(facebook|linkedin|twitter|x|instagram|youtube|crunchbase)\./i;
  if (parts.length > 1 && SOCIAL.test(parts[0])) {
    const slug = parts[parts.length - 1].replace(/^(company|in|pages)$/i, "");
    return slug ? slug.replace(/[-_]+/g, " ").trim().slice(0, 200) || null : null;
  }
  const host = parts[0];
  const label = host.split(".")[0];
  return label ? label.replace(/[-_]+/g, " ").trim().slice(0, 200) || null : null;
}

export const dataCleanupRouter = router({
  /**
   * Apollo People Enrichment for prospect emails. THIS SPENDS APOLLO CREDITS.
   *
   * dryRun defaults TRUE and makes no network call — it reports the addressable
   * set and the worst-case credit cost so spend is always knowable in advance.
   * Admin-only, and capped per run.
   *
   * Targets prospects with a LinkedIn URL (Apollo's strongest match key) rather
   * than the 1,520 contacts, which have no email, no LinkedIn URL and only a
   * lowercase company slug — ~10x the credits for a far worse hit rate.
   */
  enrichProspectEmails: adminWsProcedure
    .input(z.object({
      dryRun: z.boolean().default(true),
      limit: z.number().int().min(1).max(500).default(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const { enrichProspectEmails } = await import("../services/apolloEnrich");
      return enrichProspectEmails(ctx.workspace.id, { dryRun: input.dryRun, limit: input.limit });
    }),

  /**
   * Repair contacts. Defaults to a DRY RUN — pass dryRun:false to write.
   *
   * Sources, in priority order:
   *   companyName ← linked prospect's companyName (if not itself a URL)
   *               ← the linked account's name
   *               ← the slug of the URL currently sitting in the field
   *   email       ← linked prospect's email ONLY
   */
  repairContacts: adminWsProcedure
    .input(z.object({
      dryRun: z.boolean().default(true),
      fixCompanyNames: z.boolean().default(true),
      backfillEmails: z.boolean().default(true),
      /** Safety valve: cap how many rows a single run may modify. */
      limit: z.number().int().min(1).max(5000).default(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;

      const all = await db
        .select({
          id: contacts.id,
          email: contacts.email,
          companyName: contacts.companyName,
          companyDomain: contacts.companyDomain,
          accountId: contacts.accountId,
        })
        .from(contacts)
        .where(eq(contacts.workspaceId, wsId));

      // Source 1: prospect rows that were promoted into these contacts.
      const links = await db
        .select({
          linkedContactId: prospectQueue.linkedContactId,
          email: prospectQueue.email,
          companyName: prospectQueue.companyName,
          companyDomain: prospectQueue.companyDomain,
        })
        .from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, wsId), isNotNull(prospectQueue.linkedContactId)));
      const byContact = new Map<number, typeof links[number]>();
      for (const l of links) {
        const id = Number(l.linkedContactId);
        const prev = byContact.get(id);
        // Prefer the richest row when a contact has several prospect rows.
        if (!prev || (!prev.email && l.email) || (!prev.companyName && l.companyName)) byContact.set(id, l);
      }

      // Source 2: linked account names.
      const accountIds = [...new Set(all.map((c) => c.accountId).filter((x): x is number => !!x))];
      const accRows = accountIds.length
        ? await db.select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(and(eq(accounts.workspaceId, wsId), inArray(accounts.id, accountIds)))
        : [];
      const accName = new Map(accRows.map((a) => [Number(a.id), String(a.name ?? "")]));

      const plan: Array<{ id: number; set: Record<string, string>; why: string[] }> = [];
      let alreadyFine = 0;
      let emailUnrecoverable = 0;
      let companyUnrecoverable = 0;

      for (const c of all) {
        const set: Record<string, string> = {};
        const why: string[] = [];
        const src = byContact.get(Number(c.id));

        // ── email: only ever copied from a real prospect row ──
        if (input.backfillEmails && !c.email) {
          const found = (src?.email ?? "").trim();
          if (found) {
            set.email = found.slice(0, 320);
            why.push("email from linked prospect");
          } else {
            emailUnrecoverable++;
          }
        }

        // ── companyName: only touched when empty or holding a URL ──
        if (input.fixCompanyNames) {
          const current = (c.companyName ?? "").trim();
          const needsFix = !current || looksLikeUrl(current);
          if (needsFix) {
            const fromProspect = (src?.companyName ?? "").trim();
            const fromAccount = (accName.get(Number(c.accountId)) ?? "").trim();
            let next: string | null = null;
            if (fromProspect && !looksLikeUrl(fromProspect)) { next = fromProspect; why.push("company from linked prospect"); }
            else if (fromAccount && !looksLikeUrl(fromAccount)) { next = fromAccount; why.push("company from linked account"); }
            else if (current) { next = companyFromUrl(current); if (next) why.push("company derived from the URL in the field"); }

            if (next && next !== current) {
              set.companyName = next.slice(0, 200);
              // Preserve the URL's host as the company domain ONLY when it is
              // the company's own site — never a social profile host.
              if (!c.companyDomain && current && looksLikeUrl(current)) {
                const dom = companyDomainFromUrl(current);
                if (dom) set.companyDomain = dom;
              }
            } else if (!next) {
              companyUnrecoverable++;
            }
          } else {
            alreadyFine++;
          }
        }

        if (Object.keys(set).length > 0) plan.push({ id: Number(c.id), set, why });
      }

      const capped = plan.slice(0, input.limit);
      let updated = 0;
      if (!input.dryRun) {
        for (const p of capped) {
          try {
            await db.update(contacts).set(p.set as never)
              .where(and(eq(contacts.id, p.id), eq(contacts.workspaceId, wsId)));
            updated++;
          } catch (e) {
            console.error(`[DataCleanup] contact ${p.id} update failed:`, (e as Error).message);
          }
        }
      }

      return {
        dryRun: input.dryRun,
        totalContacts: all.length,
        wouldChange: plan.length,
        cappedTo: capped.length,
        updated,
        emailsFilled: capped.filter((p) => p.set.email).length,
        companiesFixed: capped.filter((p) => p.set.companyName).length,
        /** Honest remainder — what this pass cannot repair from existing data. */
        emailStillMissing: emailUnrecoverable,
        companyStillUnknown: companyUnrecoverable,
        companyAlreadyFine: alreadyFine,
        sample: capped.slice(0, 10),
      };
    }),
});
