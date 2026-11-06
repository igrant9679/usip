/**
 * The patch the Edit lead dialog sends (audit 2026-10-20, R81).
 *
 * The dialog sent `String(value) || undefined` for every optional field, so a
 * field someone CLEARED was left out of the patch and kept its old value. A
 * cleared field is null now, which leads.update stores. Status and owner are
 * editable, as leads.update always allowed; each is sent only when changed,
 * so saving a name does not re-fire the status-change enrolment trigger.
 */
export const LEAD_EDIT_STATUSES = ["new", "working", "qualified", "unqualified"] as const;

export type LeadEditValues = Partial<Record<
  "firstName" | "lastName" | "email" | "phone" | "title" | "company" | "source" | "status" | "ownerUserId",
  string
>>;

export function leadEditPatch(
  values: LeadEditValues,
  before: { status?: string | null; ownerUserId?: number | null },
): Record<string, string | number | null> {
  const text = (k: keyof LeadEditValues) => {
    const v = (values[k] ?? "").trim();
    return v === "" ? null : v;
  };
  const patch: Record<string, string | number | null> = {
    firstName: (values.firstName ?? "").trim(),
    lastName: (values.lastName ?? "").trim(),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    company: text("company"),
    source: text("source"),
  };
  const status = (values.status ?? "").trim();
  if (status && status !== before.status && (LEAD_EDIT_STATUSES as readonly string[]).includes(status)) patch.status = status;
  const owner = Number(values.ownerUserId);
  if (Number.isInteger(owner) && owner > 0 && owner !== before.ownerUserId) patch.ownerUserId = owner;
  return patch;
}
