/**
 * The audit entry a workspace mutation leaves when it wrote none of its own
 * (audit 2026-10-20, G49).
 *
 * The Audit page said "Not every action writes an entry yet", and many did
 * not: hundreds of procedures change records and settings and only some call
 * recordAudit. Hand-editing each would leave the next one out, so the record
 * is made in one place: workspaceProcedure, after a mutation SUCCEEDS, writes
 * an entry naming the procedure, the person and the ids in its input, unless
 * the procedure recorded its own entry during the call (recordAudit marks the
 * request; see requestContext.noteAuditRecorded), in which case nothing is
 * added, so nothing is doubled.
 *
 * What it records is deliberately narrow: numeric id fields only (`id`,
 * `ids`, `*Id`, `*Ids`, at the top of the input or one object down). Never a
 * string, so never a password, token, key, email address or message body,
 * whatever the input carried. A refused or failed call records nothing.
 */
import { auditLog } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * Mutations NOT recorded automatically, each with the reason. High-frequency,
 * low-value actions only: a person's own read state, view preferences and
 * progress, and calls that compute an answer and change nothing. A procedure
 * named here can still record its own entry.
 */
export const AUTO_AUDIT_SKIP: Record<string, string> = {
  // Read state: one per message opened.
  "notifications.markRead": "read state",
  "notifications.markAllRead": "read state",
  "conversations.markRead": "read state",
  "conversations.markSocialRead": "read state",
  "mailbox.markRead": "read state",
  "unipile.setChatRead": "read state",
  // A person's own view of the app.
  "profile.updateMyAppearance": "a person's theme",
  "dashboards.saveLayout": "a person's dashboard layout",
  "dashboardLayouts.saveLayout": "a person's dashboard layout",
  "savedSearches.markApplied": "which saved search is showing",
  "savedSearches.clearApplied": "which saved search is showing",
  "helpCenter.updateLearningPrefs": "a person's help preferences",
  // Guided-tour progress and help-centre use, per person, per step.
  "tours.startTour": "tour progress",
  "tours.advanceStep": "tour progress",
  "tours.completeTour": "tour progress",
  "tours.skipTour": "tour progress",
  "helpCenter.logSearchClick": "help search analytics",
  "helpCenter.submitFeedback": "help article feedback",
  "helpCenter.startConversation": "a help chat",
  "helpCenter.askAI": "a help chat message",
  // The assistant's conversation, one per message (its actions are recorded:
  // assistant.confirmAction is not in this list).
  "assistant.chat": "an assistant chat message",
  // Compute an answer and change nothing.
  "imports.validateRows": "checks rows, writes nothing",
  "emailTemplates.suggestSubjects": "suggests text, writes nothing",
  "mailbox.aiDraftReply": "drafts text, writes nothing",
  "mailbox.aiDraftForward": "drafts text, writes nothing",
  "conversations.draftReply": "drafts text, writes nothing",
};

export function autoAuditSkipped(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTO_AUDIT_SKIP, path);
}

/** create / delete / update, from the procedure's own name. */
export function autoAuditAction(path: string): "create" | "update" | "delete" {
  const leaf = path.slice(path.lastIndexOf(".") + 1);
  if (/^(delete|remove|purge|destroy|bulkDelete|hardDelete)/i.test(leaf)) return "delete";
  if (/^(create|add|new|insert|upload|import|clone|duplicate|fork|bulkCreate|bulkAdd)/i.test(leaf)) return "create";
  return "update";
}

const ID_NAME = /^(id|ids)$|(Id|Ids)$/;
const isIdValue = (v: unknown): v is number | number[] =>
  (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)));

/**
 * The ids an input names: numeric `id`/`ids`/`*Id`/`*Ids` fields, at the top
 * level and one plain object down ("patch.ownerUserId"). Lists are cut at 50.
 * Nothing that is not a number is ever copied.
 */
export function idsInInput(input: unknown): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const take = (k: string, v: unknown) => {
    if (!isIdValue(v)) return;
    out[k] = Array.isArray(v) ? v.slice(0, 50) : v;
  };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (ID_NAME.test(k)) { take(k, v); continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (ID_NAME.test(k2)) take(`${k}.${k2}`, v2);
      }
    }
  }
  return out;
}

/** Write the automatic entry. Never throws: an audit write must not fail the action it records. */
export async function writeAutoAudit(args: { workspaceId: number; actorUserId: number; path: string; input: unknown }): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const ids = idsInInput(args.input);
    const id = typeof ids.id === "number" ? ids.id : Array.isArray(ids.ids) && ids.ids.length === 1 ? ids.ids[0] : null;
    const dot = args.path.lastIndexOf(".");
    await db.insert(auditLog).values({
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: autoAuditAction(args.path),
      // The router ("proposals", "are.campaigns"); the procedure is in `after`.
      entityType: (dot > 0 ? args.path.slice(0, dot) : args.path).slice(0, 40),
      entityId: id != null && Number.isInteger(id) && id <= 2_147_483_647 ? id : null,
      before: null,
      after: { procedure: args.path, auto: true, ...(Object.keys(ids).length ? { ids } : {}) } as never,
    });
  } catch (e) {
    console.warn("[autoAudit] failed:", (e as Error).message);
  }
}
