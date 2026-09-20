/**
 * Referral + wrong-person follow-through (owner ask 2026-09-20).
 *
 * The Help Center promised both behaviours for months while the classifier
 * stopped at a title-only task:
 *   - person_referral: extract WHO the reply points to, create them in
 *     People through the same seams every import uses (name strip, tiered
 *     match, provenance merge — upsertPersonForRow), and draft a short
 *     referral-intro email INTO THE REVIEW QUEUE. Nothing here ever sends
 *     by itself; the draft waits for a human (or the auto-send dial) like
 *     every other AI draft. The no-email door applies: when the reply names
 *     a person but no address, the person still lands in People (where the
 *     enrichment sweep hunts addresses) and no draft is written.
 *   - already_left_company_or_not_right_person: flag the contact departed
 *     (a customFields note — never a delete) so lists can filter them; the
 *     daily LinkedIn check surfaces the new role for linked people, which
 *     feeds the Job Change Autopilot's re-engagement flow.
 *
 * Both are best-effort: a failure degrades to the task the classifier
 * already creates, never into a lost reply.
 */
import { and, eq } from "drizzle-orm";
import { contacts, emailDrafts, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { HUMAN_COPY_RULES, humanizeAiCopy } from "./humanCopy";
import { buildBrandContext } from "./brandContext";
import { upsertPersonForRow } from "./personLink";
import { usableEmailOrNull } from "../../shared/fieldHygiene";

export interface ReferralOutcome {
  handled: boolean;
  referredName?: string;
  referredEmail?: string | null;
  personId?: number | null;
  personCreated?: boolean;
  draftId?: number | null;
  detail: string;
}

function bodyOf(reply: { bodyText?: string | null; bodyHtml?: string | null }): string {
  const t = (reply.bodyText ?? "").trim();
  if (t) return t.slice(0, 4000);
  return (reply.bodyHtml ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
}

/**
 * person_referral: extraction is grounded — only a person the reply
 * EXPLICITLY names is extracted; the model must never invent one. An empty
 * extraction is a valid outcome and leaves only the task.
 */
export async function handleReferralReply(
  workspaceId: number,
  reply: {
    id: number;
    fromName?: string | null;
    fromEmail?: string | null;
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    accountId?: number | null;
    contactId?: number | null;
    userId?: number | null;
  },
): Promise<ReferralOutcome> {
  const db = await getDb();
  if (!db) return { handled: false, detail: "db unavailable" };
  const body = bodyOf(reply);
  if (!body) return { handled: false, detail: "empty reply body" };

  // 1 — grounded extraction.
  let extracted: { name?: string; email?: string; title?: string; company?: string } = {};
  try {
    const res = await invokeLLM({
      workspaceId,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You extract referral targets from email replies. The sender is pointing the writer at a DIFFERENT person to contact. " +
            "Extract ONLY a person the reply explicitly names as the one to talk to. If no specific person is named, return every field empty. " +
            "Never invent names, emails, titles or companies.",
        },
        {
          role: "user",
          content: `Reply from ${reply.fromName ?? reply.fromEmail ?? "unknown"}:\n\n${body}\n\nReturn JSON.`,
        },
      ],
      outputSchema: {
        name: "referral_extraction",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            title: { type: "string" },
            company: { type: "string" },
          },
          required: ["name", "email", "title", "company"],
        },
      },
    });
    extracted = JSON.parse(String(res.choices?.[0]?.message?.content ?? "{}"));
  } catch (e) {
    console.error(`[Referral] extraction failed for reply ${reply.id}:`, (e as Error)?.message ?? e);
    return { handled: false, detail: "extraction failed" };
  }

  const fullName = String(extracted.name ?? "").trim().slice(0, 160);
  if (!fullName) return { handled: false, detail: "no person named in the reply" };
  const parts = fullName.split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");
  const email = usableEmailOrNull(extracted.email ?? null);
  // The referrer's company is the default employer — a referral usually says
  // "talk to my colleague"; the extraction may override with an explicit one.
  const company = String(extracted.company ?? "").trim().slice(0, 200) || null;

  // 2 — into People through the ONE seam (name strip, tiered match,
  // provenance ledger). allowNameOnly: a human named this person, which is
  // the curated-contact bar, not the scraped-row bar.
  const person = await upsertPersonForRow(
    workspaceId,
    {
      firstName,
      lastName,
      email,
      linkedinUrl: null,
      phone: null,
      title: String(extracted.title ?? "").trim().slice(0, 120) || null,
      companyName: company,
      companyDomain: null,
    } as never,
    { source: "referral", confidence: 70 },
    { allowNameOnly: true },
  );
  if (!person) return { handled: false, detail: "person could not be created (no usable identity)" };

  // 3 — the intro draft, only when we can actually mail them (the no-email
  // door). Lands in the review queue as an AI draft; never sends itself.
  let draftId: number | null = null;
  if (email) {
    try {
      const [wsRow] = await db.select({ name: workspaces.name }).from(workspaces)
        .where(eq(workspaces.id, workspaceId)).limit(1);
      const senderCompany = wsRow?.name?.trim() || "our team";
      const brandBlock = await buildBrandContext(workspaceId);
      const referrer = reply.fromName || reply.fromEmail || "a colleague of yours";
      let subject = `Intro via ${referrer}`.slice(0, 240);
      let draftBody =
        `Hi ${firstName || "there"},\n\n${referrer} suggested I reach out to you. ` +
        `I'd love to find 15 minutes to introduce ${senderCompany}.\n\nWorth a quick call?`;
      try {
        const res = await invokeLLM({
          workspaceId,
          max_tokens: 350,
          messages: [
            {
              role: "system",
              content: `You write short, warm B2B referral-intro emails for ${senderCompany}. The recipient was referred by someone they know — open with that, keep it under 90 words, one clear ask. Reference ONLY facts given; never invent history.\n${brandBlock ?? ""}\n${HUMAN_COPY_RULES}`,
            },
            {
              role: "user",
              content: `Referrer: ${referrer}${company ? ` (at ${company})` : ""}. Referred person: ${fullName}${extracted.title ? `, ${extracted.title}` : ""}. The referrer replied to our outreach saying to contact this person instead. Return JSON {"subject","body"}.`,
            },
          ],
          outputSchema: {
            name: "referral_intro",
            schema: {
              type: "object",
              properties: { subject: { type: "string" }, body: { type: "string" } },
              required: ["subject", "body"],
            },
          },
        });
        const parsed = JSON.parse(String(res.choices?.[0]?.message?.content ?? "{}"));
        if (parsed.subject) subject = humanizeAiCopy(String(parsed.subject).slice(0, 240));
        if (parsed.body) draftBody = humanizeAiCopy(String(parsed.body).slice(0, 4000));
      } catch { /* template fallback above stands */ }

      const ins = await db.insert(emailDrafts).values({
        workspaceId,
        subject,
        body: draftBody,
        toProspectId: person.personId,
        toEmail: email,
        status: "pending_review",
        aiGenerated: true,
        aiPrompt: `Referral intro — ${reply.fromName ?? reply.fromEmail ?? "referrer"} pointed us at ${fullName} (reply #${reply.id})`,
        createdByUserId: reply.userId ?? null,
      } as never);
      draftId = Number((ins as any)[0]?.insertId ?? 0) || null;
    } catch (e) {
      console.error(`[Referral] intro draft failed for reply ${reply.id}:`, (e as Error)?.message ?? e);
    }
  }

  return {
    handled: true,
    referredName: fullName,
    referredEmail: email,
    personId: person.personId,
    personCreated: person.created,
    draftId,
    detail: email
      ? `created/linked ${fullName} in People and drafted the intro for review`
      : `created/linked ${fullName} in People — no email in the reply, the enrichment sweep will hunt one`,
  };
}

/**
 * already_left_company_or_not_right_person: never a delete — a departed
 * flag on the contact (customFields, merged) so views can filter, and the
 * linked person keeps their LinkedIn daily check, which is what detects the
 * new role and feeds Job Change re-engagement.
 */
export async function handleWrongPersonReply(
  workspaceId: number,
  reply: { id: number; contactId?: number | null },
): Promise<{ handled: boolean; detail: string }> {
  const db = await getDb();
  if (!db) return { handled: false, detail: "db unavailable" };
  if (!reply.contactId) return { handled: false, detail: "reply is not linked to a contact" };
  const [c] = await db.select({ id: contacts.id, customFields: contacts.customFields }).from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, reply.contactId))).limit(1);
  if (!c) return { handled: false, detail: "contact not found" };
  const prior = (c.customFields && typeof c.customFields === "object" ? c.customFields : {}) as Record<string, unknown>;
  await db.update(contacts).set({
    customFields: { ...prior, departed: true, departedNotedAt: new Date().toISOString(), departedSource: `reply #${reply.id}` },
  } as never).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, reply.contactId)));
  return { handled: true, detail: "contact flagged departed — the LinkedIn daily check surfaces their new role" };
}
