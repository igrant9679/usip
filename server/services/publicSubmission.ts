/**
 * What a public form or landing-page submission may contain (audit
 * 2026-10-20, G41).
 *
 * Both submit procedures took `z.record(z.string(), z.any())` and stored it as
 * it came: any keys, any values, nested objects, megabytes of it, and lead
 * fields (email, company, title) the form never asked for. Now a submission is
 * read against the form's own fields: undeclared keys are dropped, values are
 * text and capped, a required field must be filled and an email field must
 * look like one. A filled honeypot is a bot (shared/publicForm.ts).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { HONEYPOT_FIELD, MAX_FIELD_VALUE, MAX_SUBMISSION_KEYS } from "@shared/publicForm";

export type FormField = { key: string; label: string; required?: boolean };

/** The wire shape: flat, scalar, bounded. Checked against the form below. */
export const submissionData = z
  .record(z.string().max(64), z.union([z.string().max(MAX_FIELD_VALUE), z.number(), z.boolean(), z.null()]))
  .refine((d) => Object.keys(d).length <= MAX_SUBMISSION_KEYS, { message: "Too many fields." });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CleanedSubmission = { bot: true } | { bot: false; data: Record<string, string> };

/**
 * The submission as the form defined it. Throws BAD_REQUEST, naming the field,
 * for a missing required value or an unusable email.
 */
export function cleanSubmission(fields: unknown, raw: Record<string, unknown>): CleanedSubmission {
  const hp = raw[HONEYPOT_FIELD];
  if (hp != null && String(hp).trim() !== "") return { bot: true };
  const declared: FormField[] = Array.isArray(fields)
    ? (fields as FormField[]).filter((f) => f && typeof f.key === "string" && f.key && f.key !== HONEYPOT_FIELD)
    : [];
  const data: Record<string, string> = {};
  for (const f of declared) {
    const v = raw[f.key];
    const text = v == null || typeof v === "object" ? "" : String(v).trim().slice(0, MAX_FIELD_VALUE);
    if (f.required && !text) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Please fill in ${f.label || f.key}.` });
    }
    if (text) data[f.key] = text;
  }
  if (data.email && !EMAIL.test(data.email)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Please enter a valid email address." });
  }
  return { bot: false, data };
}
