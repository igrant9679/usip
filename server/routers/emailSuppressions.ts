/**
 * Email Suppressions Router (Feature 51)
 *
 * Handles:
 * - Unsubscribe token validation and recording (called from emailTracking.ts)
 * - tRPC procedures for listing, adding, removing suppressions
 * - CSV export and import (audit 2026-10-20, F27)
 * - The person each opt-out is about, where it is known (F7)
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import { emailSuppressions, areSuppressionList, contacts, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { isSuppressed, normalizeSuppressionEmail } from "../unsubscribe";
import { normaliseAreSuppression, suppressionPersonId } from "../services/suppression";
import { parseCSVText } from "../services/csv";
import { csvCell } from "@shared/csvCell";

/** Rows one export returns, newest first (F27). Past it the file says so. */
export const SUPPRESSION_EXPORT_MAX = 50_000;
/** Rows one import reads (F27). */
export const SUPPRESSION_IMPORT_MAX = 10_000;
const REASONS = ["unsubscribe", "bounce", "spam_complaint", "manual"] as const;
type Reason = (typeof REASONS)[number];
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "Unsubscribed", "spam", "hard bounce" … → a reason, else null. */
export function readReason(raw: string | null | undefined): Reason | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (v.startsWith("unsub") || v === "opt_out" || v === "optout") return "unsubscribe";
  if (v.includes("bounce")) return "bounce";
  if (v.includes("spam") || v.includes("complaint") || v.includes("abuse")) return "spam_complaint";
  if (v === "manual" || v === "do_not_contact" || v === "dnc") return "manual";
  return null;
}

/**
 * The rows of a suppression CSV (F27): the column headed email (or e-mail,
 * address, email address), else the first column whose cells hold addresses;
 * an optional reason and notes column. A file of bare addresses with no
 * header works too. Invalid addresses are counted, not imported.
 */
export function readSuppressionCsv(csv: string, defaultReason: Reason): {
  rows: Array<{ email: string; reason: Reason; notes: string | null }>;
  invalid: number;
  truncated: boolean;
} {
  const { headers, rows } = parseCSVText(csv);
  if (!headers.length) return { rows: [], invalid: 0, truncated: false };
  const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z]/g, "");
  let emailCol = headers.find((h) => ["email", "emailaddress", "address", "mail"].includes(norm(h)));
  // No header row: the first "header" is itself an address.
  const headerless = !emailCol && headers.some((h) => EMAIL_RE.test(h.trim()));
  const records: Array<Record<string, string>> = headerless
    ? [Object.fromEntries(headers.map((h) => [h, h])), ...rows]
    : rows;
  if (!emailCol) emailCol = headers.find((h) => (headerless ? EMAIL_RE.test(h.trim()) : records.slice(0, 20).some((r) => EMAIL_RE.test(String(r[h] ?? "").trim()))));
  if (!emailCol) return { rows: [], invalid: records.length, truncated: false };
  const reasonCol = headerless ? undefined : headers.find((h) => ["reason", "type", "status"].includes(norm(h)));
  const notesCol = headerless ? undefined : headers.find((h) => ["notes", "note", "comment", "comments"].includes(norm(h)));
  const out: Array<{ email: string; reason: Reason; notes: string | null }> = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const r of records) {
    const email = normalizeSuppressionEmail(String(r[emailCol] ?? "").replace(/^.*<([^<>]+)>\s*$/, "$1"));
    if (!email || !EMAIL_RE.test(email) || email.length > 320) { if (String(r[emailCol] ?? "").trim()) invalid++; continue; }
    const reason = (reasonCol && readReason(r[reasonCol])) || defaultReason;
    const key = `${email}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email, reason, notes: notesCol ? (String(r[notesCol] ?? "").trim().slice(0, 500) || null) : null });
  }
  return { rows: out.slice(0, SUPPRESSION_IMPORT_MAX), invalid, truncated: out.length > SUPPRESSION_IMPORT_MAX };
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

export const emailSuppressionsRouter = {
  /** List all suppressions for the workspace */
  list: workspaceProcedure
    .input(
      z.object({
        reason: z.enum(["unsubscribe", "bounce", "spam_complaint", "manual", "all"]).default("all"),
        limit: z.number().int().min(1).max(201).default(50),
        offset: z.number().int().min(0).default(0),
        /**
         * Part of an address, matched in SQL (audit 2026-10-20, O53): the page
         * filtered the one page of 50 it had fetched, so an address on page
         * three was "not found".
         */
        search: z.string().trim().max(320).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, ctx.workspace.id),
            input.reason !== "all"
              ? eq(emailSuppressions.reason, input.reason as any)
              : undefined,
            input.search ? like(emailSuppressions.email, `%${escapeLike(input.search.trim().toLowerCase())}%`) : undefined,
          )
        )
        .orderBy(desc(emailSuppressions.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      // The person each opt-out is about (F7), named for the page, from this workspace only.
      const personIds = Array.from(new Set(rows.map((r) => r.prospectId).filter((v): v is number => !!v)));
      const people = personIds.length
        ? await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName }).from(prospects)
            .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, personIds)))
        : [];
      const nameOf = new Map(people.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || null]));
      return rows.map((r) => ({ ...r, personName: r.prospectId ? nameOf.get(r.prospectId) ?? null : null }));
    }),

  /**
   * Every suppression matching the page's filter, as CSV (audit 2026-10-20,
   * F27): the page could only show 50 at a time. Admins only, like add and
   * remove: it is a list of people's addresses. Newest first, at most
   * SUPPRESSION_EXPORT_MAX rows, and it says when it stopped there. Cells are
   * spreadsheet-safe (csvCell).
   */
  exportCsv: adminWsProcedure
    .input(z.object({
      reason: z.enum(["unsubscribe", "bounce", "spam_complaint", "manual", "all"]).default("all"),
      search: z.string().trim().max(320).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailSuppressions)
        .where(and(
          eq(emailSuppressions.workspaceId, ctx.workspace.id),
          input.reason !== "all" ? eq(emailSuppressions.reason, input.reason as Reason) : undefined,
          input.search ? like(emailSuppressions.email, `%${escapeLike(input.search.trim().toLowerCase())}%`) : undefined,
        ))
        .orderBy(desc(emailSuppressions.createdAt), desc(emailSuppressions.id))
        .limit(SUPPRESSION_EXPORT_MAX + 1);
      const truncated = rows.length > SUPPRESSION_EXPORT_MAX;
      const kept = rows.slice(0, SUPPRESSION_EXPORT_MAX);
      const header = ["email", "reason", "source", "notes", "person_id", "created_at"];
      const lines = kept.map((r) => [r.email, r.reason, r.source, r.notes, r.prospectId, r.createdAt].map(csvCell).join(","));
      return { csv: [header.join(","), ...lines].join("\r\n") + "\r\n", count: kept.length, truncated };
    }),

  /**
   * Suppressions from a CSV (audit 2026-10-20, F27): the column headed email,
   * an optional reason column (unsubscribe, bounce, spam, manual; else the
   * reason chosen on the page) and notes. Each address is matched to the
   * People row with it, so the opt-out follows the person (F7), except a
   * bounce. Already-suppressed addresses are counted and left alone. This can
   * only stop sends.
   */
  importCsv: adminWsProcedure
    .input(z.object({
      csv: z.string().min(1).max(5_000_000),
      defaultReason: z.enum(REASONS).default("manual"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const parsed = readSuppressionCsv(input.csv, input.defaultReason);
      if (!parsed.rows.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: parsed.invalid ? `No valid addresses in the file (${parsed.invalid} could not be read).` : "The file has no email column or no addresses." });
      }
      let added = 0;
      let already = 0;
      for (let i = 0; i < parsed.rows.length; i += 500) {
        const batch = parsed.rows.slice(i, i + 500);
        const emails = Array.from(new Set(batch.map((r) => r.email)));
        const [existing, people] = await Promise.all([
          db.select({ email: emailSuppressions.email, reason: emailSuppressions.reason }).from(emailSuppressions)
            .where(and(eq(emailSuppressions.workspaceId, ctx.workspace.id), inArray(emailSuppressions.email, emails))),
          db.select({ id: prospects.id, email: prospects.email }).from(prospects)
            .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.email, emails)))
            .orderBy(asc(prospects.id)),
        ]);
        const have = new Set(existing.map((r) => `${normalizeSuppressionEmail(r.email)}|${r.reason}`));
        const personOf = new Map<string, number>();
        for (const p of people) { const e = normalizeSuppressionEmail(p.email); if (e && !personOf.has(e)) personOf.set(e, p.id); }
        const fresh = batch.filter((r) => !have.has(`${r.email}|${r.reason}`));
        already += batch.length - fresh.length;
        if (fresh.length) {
          await db.insert(emailSuppressions).ignore().values(fresh.map((r) => ({
            workspaceId: ctx.workspace.id,
            email: r.email,
            reason: r.reason,
            source: "import",
            notes: r.notes,
            prospectId: r.reason === "bounce" ? null : personOf.get(r.email) ?? null,
          })) as never);
          added += fresh.length;
        }
      }
      return { ok: true as const, added, alreadySuppressed: already, invalid: parsed.invalid, truncated: parsed.truncated, max: SUPPRESSION_IMPORT_MAX };
    }),

  /** Manually add a suppression */
  add: adminWsProcedure
    .input(
      z.object({
        email: z.string().email(),
        reason: z.enum(["unsubscribe", "bounce", "spam_complaint", "manual"]),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Find linked contact if any
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), eq(contacts.email, input.email)))
        .limit(1);
      await db.insert(emailSuppressions).ignore().values({
        workspaceId: ctx.workspace.id,
        email: normalizeSuppressionEmail(input.email),
        reason: input.reason,
        contactId: contact?.id,
        // The person, so the opt-out follows them (F7); never for a bounce.
        prospectId: await suppressionPersonId(ctx.workspace.id, { reason: input.reason, contactId: contact?.id ?? null, email: input.email }),
        notes: input.notes,
      });
      return { ok: true };
    }),

  /** Remove a suppression by id */
  remove: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.id, input.id),
            eq(emailSuppressions.workspaceId, ctx.workspace.id)
          )
        );
      return { ok: true };
    }),

  /** Summary counts by reason */
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.workspaceId, ctx.workspace.id));
    const counts = { unsubscribe: 0, bounce: 0, spam_complaint: 0, manual: 0, total: rows.length };
    for (const r of rows) counts[r.reason]++;
    return counts;
  }),

  /**
   * Bulk opt-out: suppress every selected prospect's email (do-not-contact), so
   * the autopilots + sequences stop reaching them. Resolves emails server-side
   * from prospectIds; idempotent (.ignore() on the suppression insert).
   */
  addByProspects: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ id: prospects.id, email: prospects.email, linkedinUrl: prospects.linkedinUrl })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, input.prospectIds)));
      // By PERSON (audit 2026-10-20, F7): each opt-out carries the People row,
      // so it holds when the person gets a new address. A person with no
      // address used to be skipped; they go on the do-not-contact list by
      // their People row (and LinkedIn profile) instead.
      let suppressed = 0;
      let byPersonOnly = 0;
      const done = new Set<string>();
      for (const p of rows) {
        const email = normalizeSuppressionEmail(p.email);
        try {
          if (email) {
            if (done.has(email)) continue;
            done.add(email);
            await db.insert(emailSuppressions).ignore().values({
              workspaceId: ctx.workspace.id,
              email,
              reason: "manual",
              prospectId: p.id,
              notes: "Bulk opt-out from People",
            });
            suppressed++;
          } else {
            await db.insert(areSuppressionList).values(normaliseAreSuppression({
              workspaceId: ctx.workspace.id,
              email: null,
              linkedinUrl: p.linkedinUrl ?? null,
              reason: "do_not_contact" as const,
              addedByUserId: ctx.user.id,
              prospectId: p.id,
            }) as never);
            byPersonOnly++;
          }
        } catch { /* dupe or bad row — skip */ }
      }
      return { ok: true as const, suppressed: suppressed + byPersonOnly, byPersonOnly, selected: input.prospectIds.length };
    }),
};

/**
 * Standalone helper — check if an email is suppressed for a given workspace.
 * Used by smtpConfig.sendDraft before calling transporter.sendMail.
 */
/**
 * Delegates to isSuppressed in unsubscribe.ts so there is ONE implementation.
 * These two had drifted: this one lowercased without trimming, which on a NO PAD
 * collation means a stored-or-queried address with a stray space never matched.
 */
export async function isEmailSuppressed(workspaceId: number, email: string): Promise<boolean> {
  return isSuppressed(workspaceId, email);
}

/** Whose address a tracking token unsubscribes, without acting on it — for the confirmation page. */
export async function unsubscribeTargetByToken(token: string): Promise<{ email: string } | null> {
  const { emailDrafts } = await import("../../drizzle/schema");
  const db = await getDb();
  if (!db) return null;
  const [draft] = await db
    .select({ toEmail: emailDrafts.toEmail })
    .from(emailDrafts)
    .where(eq(emailDrafts.trackingToken, token))
    .limit(1);
  return draft?.toEmail ? { email: normalizeSuppressionEmail(draft.toEmail) } : null;
}

/**
 * Standalone helper — record an unsubscribe from a tracking token.
 * Called by the POST /api/track/unsubscribe/:token Express route: the
 * confirmation form and RFC 8058 one-click both post there. GET only asks.
 */
export async function recordUnsubscribeByToken(
  token: string,
  userAgent?: string,
  source: "link_confirmed" | "one_click_header" = "one_click_header",
): Promise<{ ok: boolean; email?: string }> {
  const { emailDrafts } = await import("../../drizzle/schema");
  const db = await getDb();
  if (!db) return { ok: false };
  const [draft] = await db
    .select({
      id: emailDrafts.id,
      workspaceId: emailDrafts.workspaceId,
      toEmail: emailDrafts.toEmail,
      toContactId: emailDrafts.toContactId,
      toProspectId: emailDrafts.toProspectId,
    })
    .from(emailDrafts)
    .where(eq(emailDrafts.trackingToken, token))
    .limit(1);
  if (!draft || !draft.toEmail) return { ok: false };
  const email = draft.toEmail.toLowerCase();
  // Insert suppression (ignore duplicate)
  await db.insert(emailSuppressions).ignore().values({
    workspaceId: draft.workspaceId,
    email,
    reason: "unsubscribe",
    source,
    draftId: draft.id,
    contactId: draft.toContactId ?? undefined,
    // The person the draft was to (F7), so the opt-out follows them.
    prospectId: await suppressionPersonId(draft.workspaceId, { reason: "unsubscribe", prospectId: draft.toProspectId ?? null, contactId: draft.toContactId ?? null, email }),
    notes: userAgent ? `UA: ${userAgent.slice(0, 200)}` : undefined,
  });
  return { ok: true, email };
}
