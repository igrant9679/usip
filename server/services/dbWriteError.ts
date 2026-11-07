/**
 * What a failed INSERT or UPDATE means, in words a person can act on.
 *
 * drizzle wraps the driver's error: `.message` is the SQL text, and the MySQL
 * code ("ER_DATA_TOO_LONG") and reason ("Data too long for column 'title' at
 * row 1") sit on `.cause`. Screens showed the SQL, and the import report wrote
 * "Database insert failed" for every row whatever the reason (audit
 * 2026-10-20, R54 / R87).
 *
 * Returns null when the error is not one of these, so the caller can fall back
 * to its own wording.
 */
export function describeWriteError(e: unknown): string | null {
  const err = e as { code?: unknown; message?: unknown; sqlMessage?: unknown; cause?: unknown } | null;
  const cause = (err?.cause ?? err) as { code?: unknown; sqlMessage?: unknown; message?: unknown } | null;
  const code = String(cause?.code ?? err?.code ?? "");
  const reason = String(cause?.sqlMessage ?? cause?.message ?? "");
  const column = reason.match(/column '([^']+)'/i)?.[1];
  const field = column ? column.replace(/_/g, " ") : null;
  if (code === "ER_DATA_TOO_LONG" || /data too long/i.test(reason)) {
    return field ? `${field} is too long` : "a value is too long";
  }
  if (code === "ER_DUP_ENTRY" || /duplicate entry/i.test(reason)) {
    const key = reason.match(/for key '([^']+)'/i)?.[1];
    return key ? `a record with this value already exists (${key})` : "a record with this value already exists";
  }
  if (code === "ER_BAD_NULL_ERROR" || /cannot be null/i.test(reason)) {
    return field ? `${field} is required` : "a required value is missing";
  }
  if (code === "ER_TRUNCATED_WRONG_VALUE" || code === "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD" || /incorrect .* value/i.test(reason)) {
    return field ? `${field} has a value that isn't valid` : "a value isn't valid";
  }
  return null;
}

/** A unique index refused the write — and nothing else (audit 2026-10-20, R75). */
export function isDuplicateKeyError(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; cause?: unknown } | null;
  const cause = (err?.cause ?? err) as { code?: unknown; errno?: unknown; sqlMessage?: unknown; message?: unknown } | null;
  return cause?.code === "ER_DUP_ENTRY" || err?.code === "ER_DUP_ENTRY" || cause?.errno === 1062 || err?.errno === 1062;
}
