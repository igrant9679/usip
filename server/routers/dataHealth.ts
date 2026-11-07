import { TRPCError } from "@trpc/server";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { contacts, prospects, prospectQueue } from "../../drizzle/schema";
import { getDb } from "../db";
import { mergeContacts } from "../services/contactMerge";
import { DUPLICATE_GROUP_SCAN_CAP, healthMetricsFrom } from "../services/dataHealthMetrics";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, isAdminRole, managerProcedure, repProcedure, requireMinRole, workspaceProcedure } from "../_core/workspace";

export const dataHealthRouter = router({
  /**
   * Data Health describes PEOPLE (`prospects`), the sitewide person record.
   *
   * Owner directive 2026-08-17: one location for every person; the scrapers,
   * ARE, and enrichment all contribute to and read from People and Companies.
   * This procedure used to count `contacts` — the older CRM table that the
   * 0160 fold-in made a one-directional mirror of People — so it reported the
   * table enrichment never writes to. Live on 2026-08-16 that read "0 of 1,520
   * with email, 100% missing" for LSI while 1,505 People rows HAD emails, and
   * Home turned that into a paid-enrichment nudge (deep test report #4).
   *
   * Vocabulary note, checked against prod rather than the schema comment:
   * `prospects.emailStatus` carries Reoon's verdicts (valid / accept_all /
   * risky / invalid / unknown) — the comment saying "verified|unverified|
   * unavailable" is stale. So the four verification buckets map 1:1; nothing
   * is invented. `withCompany` means "has an employer" here (company name or
   * domain), not "linked to an account row" — People are enriched with an
   * employer long before association links them to a Companies record.
   */
  /**
   * The credits card on the Data health center (audit 2026-10-20, F10):
   * what verification and lookups have left, where it can be known.
   *
   *   Reoon        on the workspace's OWN key, the account balance from the
   *                balance endpoint (it spends no credits; the Settings key
   *                test reads the same call); on the shared key, today's
   *                allowance under its cap, never the platform account's
   *                balance, which is not this workspace's to see
   *   QuickEnrich  emails delivered this month (the spend ledger's billed
   *                unit) and today's discovery pulls against the cap
   *   LinkedIn     lookups left today on the accounts this person may use
   *
   * A vendor that cannot answer is reported as such, never as zero.
   */
  credits: workspaceProcedure.query(async ({ ctx }) => {
    const wsId = ctx.workspace.id;
    const { sourceBudgets } = await import("../services/sourceBudgets");
    const { getReoonKey, reoonCheckBalance } = await import("../services/reoon");
    const { keySourceOf, spendDay, spendSince } = await import("../services/spend");
    const b = await sourceBudgets(wsId, ctx.user.id, isAdminRole(ctx.member.role));

    let reoonBalance: { daily: number; instant: number } | null = null;
    let reoonError: string | null = null;
    const key = b.reoon.configured ? await getReoonKey(wsId) : "";
    if (key && keySourceOf(key, process.env.REOON_API_KEY) === "workspace") {
      try {
        const bal = await reoonCheckBalance(key);
        if (bal.api_status && bal.api_status !== "success") reoonError = "Reoon did not accept this workspace's key.";
        else reoonBalance = { daily: Number(bal.remaining_daily_credits ?? 0), instant: Number(bal.remaining_instant_credits ?? 0) };
      } catch (e) {
        reoonError = `Reoon's balance could not be read: ${(e as Error).message}`.slice(0, 200);
      }
    }

    const today = spendDay();
    const monthRows = await spendSince(`${today.slice(0, 8)}01`, wsId);
    const qeEmailsThisMonth = monthRows
      .filter((r) => r.vendor === "quickenrich" && r.meter === "email_hits")
      .reduce((sum, r) => sum + r.quantity, 0);

    return {
      reoon: { configured: b.reoon.configured, keySource: b.reoon.keySource, balance: reoonBalance, error: reoonError, allowance: b.reoon.allowance },
      quickenrich: { configured: b.quickenrich.configured, emailsThisMonth: qeEmailsThisMonth, pulls: b.quickenrich.allowance },
      linkedin: b.linkedin,
      month: today.slice(0, 7),
    };
  }),

  getMetrics: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    const [totals] = await db
      .select({
        total: count(),
        withEmail: sql<number>`SUM(CASE WHEN ${prospects.email} IS NOT NULL AND ${prospects.email} != '' THEN 1 ELSE 0 END)`,
        withPhone: sql<number>`SUM(CASE WHEN ${prospects.phone} IS NOT NULL AND ${prospects.phone} != '' THEN 1 ELSE 0 END)`,
        withCompany: sql<number>`SUM(CASE WHEN (${prospects.company} IS NOT NULL AND ${prospects.company} != '') OR (${prospects.companyDomain} IS NOT NULL AND ${prospects.companyDomain} != '') THEN 1 ELSE 0 END)`,
        withTitle: sql<number>`SUM(CASE WHEN ${prospects.title} IS NOT NULL AND ${prospects.title} != '' THEN 1 ELSE 0 END)`,
        withLinkedIn: sql<number>`SUM(CASE WHEN ${prospects.linkedinUrl} IS NOT NULL AND ${prospects.linkedinUrl} != '' THEN 1 ELSE 0 END)`,
        verifiedValid: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'valid' THEN 1 ELSE 0 END)`,
        verifiedAcceptAll: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'accept_all' THEN 1 ELSE 0 END)`,
        verifiedRisky: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'risky' THEN 1 ELSE 0 END)`,
        verifiedInvalid: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'invalid' THEN 1 ELSE 0 END)`,
        verifiedUnknown: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} IS NULL OR ${prospects.emailStatus} = 'unknown' THEN 1 ELSE 0 END)`,
        // Enriched means an enrichment pass ran, which stamps lastEnrichedAt.
        // updatedAt moved on any edit, so a renamed title counted as enriched
        // (audit 2026-10-20, P78).
        enrichedLast90Days: sql<number>`SUM(CASE WHEN ${prospects.lastEnrichedAt} >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 ELSE 0 END)`,
      })
      .from(prospects)
      .where(eq(prospects.workspaceId, wsId));

    // Addresses held by more than one People row, grouped as planPeopleMerge
    // groups them; mergeableEmailGroups drops what that merge never takes.
    const dupEmailRows = await db
      .select({ email: prospects.email })
      .from(prospects)
      .where(and(
        eq(prospects.workspaceId, wsId),
        sql`${prospects.email} IS NOT NULL AND ${prospects.email} <> ''`,
        sql`${prospects.email} LIKE '%@%.%'`,
      ))
      .groupBy(prospects.email)
      .having(sql`COUNT(*) > 1`)
      .limit(DUPLICATE_GROUP_SCAN_CAP + 1);

    return healthMetricsFrom(totals, dupEmailRows);
  }),

  /**
   * Merge duplicate contacts: the survivor keeps its values and fills blanks
   * from the duplicate, every reference moves to it, and the duplicate is
   * deleted — through services/contactMerge, in one transaction, audited
   * (audit 2026-10-20, P9). Admin only: it deletes a record, and was open to
   * reps.
   */
  mergeContacts: adminWsProcedure
    .input(z.object({
      primaryId: z.number(),
      secondaryId: z.number(),
      /** Which fields to take from secondary (overrides primary's empty/null value). */
      overrideFields: z.array(z.string()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return mergeContacts(db, ctx.workspace.id, { ...input, actorUserId: ctx.user.id });
    }),

  /**
   * Every record in a duplicate-contact group, for the merge dialog. It
   * loaded the first two and said "only the first two are shown" (audit
   * 2026-10-20, P95). The fields are the ones a merge can carry over.
   */
  duplicateGroupRecords: workspaceProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select({
          id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
          title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl, city: contacts.city,
          seniority: contacts.seniority, accountId: contacts.accountId, createdAt: contacts.createdAt,
        })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.ids)))
        .orderBy(contacts.createdAt, contacts.id);
    }),

  /**
   * How much data the old CSV column matcher mis-filed (fixed in 8c967cc).
   *
   * READ-ONLY, and deliberately not paired with a repair action: the counts
   * have to be read before anyone decides what — if anything — to change.
   * Admin-scoped because it reports every import in the workspace, including
   * other members' filenames and column mappings.
   */
  /**
   * One-shot: bring every linked contact up to date with its People row,
   * fill-only. The seam in personLink.mirrorPersonFieldsToContacts keeps them
   * aligned from here on; this catches up the rows that diverged BEFORE it
   * existed (LSI: 1,520 contacts with no email, People has them). Same rule
   * as the seam — a contact's existing value always wins; only gaps fill.
   * Admin-only and dry-run by default, because it writes to a CRM table.
   */
  syncContactsFromPeople: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true), limit: z.number().int().min(1).max(5000).default(5000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const rows = await db
        .select({
          contactId: contacts.id,
          cEmail: contacts.email, cPhone: contacts.phone, cTitle: contacts.title, cLinkedin: contacts.linkedinUrl,
          cCompany: contacts.companyName, cDomain: contacts.companyDomain,
          pEmail: prospects.email, pPhone: prospects.phone, pTitle: prospects.title, pLinkedin: prospects.linkedinUrl,
          pCompany: prospects.company, pDomain: prospects.companyDomain,
        })
        .from(contacts)
        .innerJoin(prospects, and(eq(prospects.id, contacts.personProspectId), eq(prospects.workspaceId, wsId)))
        .where(eq(contacts.workspaceId, wsId))
        .limit(input.limit);
      const empty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
      let scanned = 0, wouldFill = 0, filled = 0;
      const byField: Record<string, number> = {};
      for (const r of rows) {
        scanned++;
        const patch: Record<string, unknown> = {};
        const pairs: Array<[string, unknown, unknown, number]> = [
          ["email", r.cEmail, r.pEmail, 320], ["phone", r.cPhone, r.pPhone, 40], ["title", r.cTitle, r.pTitle, 120],
          ["linkedinUrl", r.cLinkedin, r.pLinkedin, 200], ["companyName", r.cCompany, r.pCompany, 200], ["companyDomain", r.cDomain, r.pDomain, 200],
        ];
        for (const [col, cur, from, width] of pairs) {
          if (empty(cur) && !empty(from)) { patch[col] = String(from).slice(0, width); byField[col] = (byField[col] ?? 0) + 1; }
        }
        if (Object.keys(patch).length === 0) continue;
        wouldFill++;
        if (!input.dryRun) {
          await db.update(contacts).set(patch as never)
            .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, r.contactId)));
          filled++;
        }
      }
      return { dryRun: input.dryRun, scanned, contactsWithGaps: wouldFill, filled, byField };
    }),

  /**
   * One-shot: push queue-row emails up to their linked People rows where the
   * People row has none. The seam in enrichmentSweeper now does this on every
   * new find; this catches up the rows the sweeper found BEFORE it did (CF:
   * 8 actively-sequenced prospects with a queue email and no People email).
   * Goes through mergeIntoPerson — provenance recorded, stronger values kept
   * — never a blind copy. Admin-only, dry-run by default.
   */
  syncPeopleFromQueue: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true), limit: z.number().int().min(1).max(5000).default(5000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const rows = await db
        .select({ queueId: prospectQueue.id, personId: prospectQueue.personProspectId, qEmail: prospectQueue.email, pEmail: prospects.email })
        .from(prospectQueue)
        .innerJoin(prospects, and(eq(prospects.id, prospectQueue.personProspectId), eq(prospects.workspaceId, wsId)))
        .where(and(
          eq(prospectQueue.workspaceId, wsId),
          sql`${prospectQueue.email} IS NOT NULL AND ${prospectQueue.email} <> ''`,
          sql`(${prospects.email} IS NULL OR ${prospects.email} = '')`,
        ))
        .limit(input.limit);
      // One push per PERSON — several queue rows can link to one People row.
      const byPerson = new Map<number, string>();
      for (const r of rows) if (r.personId && r.qEmail && !byPerson.has(r.personId)) byPerson.set(r.personId, r.qEmail);
      let pushed = 0;
      if (!input.dryRun) {
        const { mergeIntoPerson } = await import("../services/personLink");
        for (const [personId, email] of Array.from(byPerson.entries())) {
          await mergeIntoPerson(wsId, personId, { email, source: "sync_from_queue" });
          pushed++;
        }
      }
      return { dryRun: input.dryRun, queueRowsWithEmailPeopleWithout: rows.length, distinctPeople: byPerson.size, pushed };
    }),

  importMappingAudit: adminWsProcedure.query(async ({ ctx }) => {
    const { auditImportMappings } = await import("../services/importMappingAudit");
    return auditImportMappings(ctx.workspace.id);
  }),

  getDuplicateGroups: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    // Email duplicates
    const emailDups = await db.execute(
      sql`SELECT email, GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(firstName, ' ', lastName) ORDER BY createdAt SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspaceId = ${wsId} AND email IS NOT NULL AND email != ''
          GROUP BY email HAVING COUNT(*) > 1
          ORDER BY cnt DESC LIMIT 10`
    ) as any;

    // Name+account duplicates
    const nameDups = await db.execute(
      sql`SELECT CONCAT(firstName, ' ', lastName, ' (acct:', COALESCE(accountId, 0), ')') as key_val,
          GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(firstName, ' ', lastName) ORDER BY createdAt SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspaceId = ${wsId} AND firstName IS NOT NULL AND lastName IS NOT NULL AND accountId IS NOT NULL
          GROUP BY firstName, lastName, accountId HAVING COUNT(*) > 1
          ORDER BY cnt DESC LIMIT 10`
    ) as any;

    const rows = (emailDups as any[])[0] ?? [];
    const nameRows = (nameDups as any[])[0] ?? [];

    const mapGroup = (row: any, type: "email" | "name") => ({
      type,
      key: type === "email" ? row.email : row.key_val,
      ids: String(row.ids).split(","),
      names: String(row.names).split("||"),
      count: Number(row.cnt),
    });

    return [
      ...rows.map((r: any) => mapGroup(r, "email")),
      ...nameRows.map((r: any) => mapGroup(r, "name")),
    ].slice(0, 20);
  }),

  /**
   * People who are ALSO a CRM contact, with no link between the two rows
   * (2026-09-20). The two duplicate checks above are both single-table —
   * `getMetrics` counts People against People, `getDuplicateGroups` counts
   * contacts against contacts — so the commonest real duplicate in the
   * product was reported by neither: one human, a People row and a contact
   * row, `person_prospect_id` null or aimed at a third shell record.
   *
   * ONE procedure returns the count AND the list, `companies.duplicates`
   * style, so the card and the rows beneath it are the same payload and
   * cannot drift apart the way the People "Duplicates" card drifted from the
   * contacts list under it. Deliberately NOT folded into `getMetrics`: that
   * payload is also read by Home and Data Enrichment, neither of which
   * renders a duplicates figure, and neither should pay for a cross-table
   * join on every load.
   */
  personContactDuplicates: workspaceProcedure.query(async ({ ctx }) => {
    const { findPersonContactDuplicates } = await import("../services/personContactDuplicates");
    return findPersonContactDuplicates(ctx.workspace.id, { limit: 50 });
  }),

  /**
   * Repair by LINKING. Never a delete and never a People merge: a merge is a
   * different, irreversible operation and it lives behind its own plan-then-
   * confirm in `planPeopleMerge` / `executePeopleMerge` below, which is why a
   * `needs_merge` row is reported here with a reason and no button.
   *
   * The link is not free of side effects and the UI says so: the repair is
   * `upsertPersonForContact`, which runs the contact's curated values through
   * `mergeAll` at the crm_contact tier and writes the winners onto the People
   * row with a field-history entry.
   *
   * The server re-classifies before it writes. A `kind` from the client is a
   * stale opinion about a row that may have changed since the page loaded,
   * and acting on it is how a correctly-linked contact gets re-pointed at a
   * duplicate. Manager gate on `relinkable` only: linking an UNLINKED contact
   * is what the nightly backfill already does unattended, but re-pointing a
   * linked one changes who a campaign "Add existing" enrols and which contact
   * a later promotion reuses.
   */
  linkPersonContactPairs: repProcedure
    .input(z.object({
      contactIds: z.array(z.number().int().positive()).min(1).max(200),
      dryRun: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const { findPersonContactDuplicates, SCAN_CAP } = await import("../services/personContactDuplicates");
      const fresh = await findPersonContactDuplicates(wsId, { limit: SCAN_CAP });
      const byContact = new Map<number, (typeof fresh.pairs)[number]>();
      for (const p of fresh.pairs) byContact.set(p.contactId, p);

      const accepted: typeof fresh.pairs = [];
      const refused: Array<{ contactId: number; reason: string }> = [];
      const stale: number[] = [];
      for (const id of input.contactIds) {
        const pair = byContact.get(id);
        if (!pair) { stale.push(id); continue; }
        if (pair.kind === "needs_merge") { refused.push({ contactId: id, reason: pair.reason }); continue; }
        accepted.push(pair);
      }
      if (accepted.some((p) => p.kind === "relinkable")) {
        requireMinRole(ctx.member.role, "manager", "Re-pointing a contact that is already linked needs a manager.");
      }
      if (input.dryRun) {
        return {
          dryRun: true, linked: 0, relinked: 0,
          wouldLink: accepted.map((p) => ({ contactId: p.contactId, personId: p.personId, kind: p.kind })),
          refused, stale, mismatched: [] as Array<{ contactId: number; expectedPersonId: number; linkedPersonId: number }>,
        };
      }

      const { usableEmailOrNull } = await import("@shared/fieldHygiene");
      const { upsertPersonForContact } = await import("../services/personLink");
      const mismatched: Array<{ contactId: number; expectedPersonId: number; linkedPersonId: number }> = [];
      let linked = 0, relinked = 0;
      for (const pair of accepted) {
        const [c] = await db.select().from(contacts)
          .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, pair.contactId)))
          .limit(1);
        if (!c) { stale.push(pair.contactId); continue; }
        // Detection matched on the raw column; the matcher's email tier is
        // shape-gated. A row that passes one and fails the other would fall
        // through to the name tiers and INSERT a third person — so refuse
        // rather than turn "link these two" into "create another".
        if (!usableEmailOrNull(c.email)) {
          refused.push({ contactId: pair.contactId, reason: "the contact no longer carries a usable email." });
          continue;
        }
        const result = await upsertPersonForContact(wsId, c);
        if (!result) { refused.push({ contactId: pair.contactId, reason: "the contact has no person identity." }); continue; }
        if (result.personId !== pair.personId) {
          mismatched.push({ contactId: pair.contactId, expectedPersonId: pair.personId, linkedPersonId: result.personId });
          continue;
        }
        if (pair.kind === "relinkable") relinked++; else linked++;
      }

      await recordAudit({
        workspaceId: wsId, actorUserId: ctx.user.id, action: "update",
        entityType: "person_contact_link", entityId: 0,
        after: { linked, relinked, refused, mismatched, stale },
      });
      return { dryRun: false, linked, relinked, refused, stale, mismatched, wouldLink: [] as Array<{ contactId: number; personId: number; kind: string }> };
    }),

  /**
   * "Link all unlinked" — the existing backfill, not a second batch loop.
   * `linkUnlinkedContacts` is already keyset-drained and already isolates
   * per-row failures.
   *
   * Audit 2026-10-20, P93: any rep could run it, it scanned up to 10,000
   * contacts inside one request, and it linked a contact to a People row on a
   * name match, merging the contact's values onto what may be another human.
   * Now: managers only; one page per call, with a cursor to carry on from;
   * and only on an address or a LinkedIn profile. A contact whose only match
   * is by name is left alone and counted, for someone to look at. The nightly
   * backfill is unchanged.
   */
  relinkAllUnlinked: managerProcedure
    .input(z.object({ afterId: z.number().int().min(0).default(0) }).default({ afterId: 0 }))
    .mutation(async ({ ctx, input }) => {
      const { linkUnlinkedContacts, RELINK_PAGE } = await import("../services/personLink");
      return linkUnlinkedContacts({
        workspaceId: ctx.workspace.id, afterId: input.afterId, limit: RELINK_PAGE, maxPages: 1, keysOnly: true,
      });
    }),

  /**
   * PEOPLE MERGE — plan (read-only) and execute (destructive).
   *
   * 🔒 WHY adminWsProcedure AND NO FEATURE KEY. The six keys in
   * `@shared/permissions` are export_data, manage_sequences, view_all_leads,
   * manage_integrations, access_billing and manage_api_keys. Not one of them
   * describes "permanently delete a customer's People rows": `export_data` is
   * about data LEAVING the workspace and gating a delete on it would be a lie
   * to every admin who reads the Permissions tab, and adding a seventh key
   * would ship a toggle that defaults to GRANTED for managers and reps
   * (`defaultGranted` grants anything not in RESTRICTED_BY_DEFAULT), which is
   * the opposite of what this needs. Role is the right gate: admin or above,
   * with no way to delegate it per member.
   *
   * The plan writes nothing and is safe to render on sight. Execute is the
   * only destructive path, and it takes the clusters BY NAME.
   */
  planPeopleMerge: adminWsProcedure
    .input(z.object({
      /**
       * WHAT THE ROWS ARE GROUPED ON. "email" is the pass that ran against
       * production on 2026-09-20 and stays the default, so a client that does
       * not know the option gets exactly the behaviour it had.
       *
       * "linkedin" groups on the normalised `/in/<slug>` instead — the ~90 LSI
       * Media duplicates the email pass cannot see, because enrichment guessed
       * two address PATTERNS for one human and both rows kept theirs.
       */
      by: z.enum(["email", "linkedin"]).default("email"),
      emails: z.array(z.string()).max(200).optional(),
      /** The general spelling of `emails`; in email mode they are the same. */
      keys: z.array(z.string()).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).default({ by: "email", limit: 50 }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { planPersonMerge } = await import("../services/personMerge");
      return planPersonMerge(db, ctx.workspace.id, { by: input.by, emails: input.emails, keys: input.keys, limit: input.limit });
    }),

  /**
   * Apply a merge. IRREVERSIBLE: the losing People rows are deleted.
   *
   * `clusters` is REQUIRED and non-empty — there is deliberately no "merge
   * every duplicate" call. Each entry echoes back the survivor and loser ids
   * the plan SHOWED, not just the address: the service re-plans server-side and
   * then refuses any cluster whose rows no longer match what was approved. An
   * email alone would have let a row imported while the dialog was open — or a
   * contact linked by the repair section directly above on the same page — move
   * the survivor underneath the operator (2026-09-20 review, defects 8 and 12).
   */
  executePeopleMerge: adminWsProcedure
    .input(z.object({
      /** Must match the pass the operator was LOOKING at: one cluster is named
       *  by an address in email mode and by a LinkedIn slug in linkedin mode,
       *  and a key resolved in the wrong mode resolves to nothing — which is
       *  reported as stale rather than guessed at. */
      by: z.enum(["email", "linkedin"]).default("email"),
      clusters: z.array(z.object({
        // `email` is how every caller written before the LinkedIn key spells
        // it; `key` is the general one. At least one of them is required.
        email: z.string().min(3).optional(),
        key: z.string().min(3).optional(),
        survivorId: z.number().int().positive(),
        loserIds: z.array(z.number().int().positive()).min(1).max(50),
      }).refine((c) => !!(c.email || c.key), { message: "a cluster must name its email or its key" })).min(1).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { executePersonMerge } = await import("../services/personMerge");
      return executePersonMerge(db, ctx.workspace.id, { by: input.by, clusters: input.clusters, actorUserId: ctx.user.id });
    }),

  /**
   * Provider effectiveness (roadmap P4.1) — which source actually EARNS its
   * keep. Zero new writes: the winning source per field already sits in
   * every prospect's field_provenance ledger; this is the GROUP BY the
   * audit said was "one query away". Bounded read of the ledger column only.
   */
  providerEffectiveness: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { prospects } = await import("../../drizzle/schema");
    const rows = await db
      .select({ ledger: prospects.fieldProvenance })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, ctx.workspace.id), sql`${prospects.fieldProvenance} IS NOT NULL`))
      .limit(5000);

    // source → field → { holding: rows where this source's value is current,
    //                    verified: of those, email rows Reoon judged valid }
    const bySource: Record<string, { total: number; fields: Record<string, number>; verifiedEmails: number }> = {};
    for (const r of rows) {
      const ledger = (r.ledger ?? {}) as Record<string, { source?: string; verification?: string } | undefined>;
      for (const [field, entry] of Object.entries(ledger)) {
        if (!entry?.source) continue;
        const s = (bySource[entry.source] ??= { total: 0, fields: {}, verifiedEmails: 0 });
        s.total++;
        s.fields[field] = (s.fields[field] ?? 0) + 1;
        if (field === "email" && entry.verification === "valid") s.verifiedEmails++;
      }
    }
    return {
      prospectsWithLedger: rows.length,
      sources: Object.entries(bySource)
        .map(([source, v]) => ({ source, ...v }))
        .sort((a, b) => b.total - a.total),
    };
  }),
});
