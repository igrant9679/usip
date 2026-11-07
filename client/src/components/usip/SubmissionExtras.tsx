import { submissionExtras } from "@/lib/submissionFields";

/** A submission's other fields (phone, message, …) under its name line (G63). */
export function SubmissionExtras({ data }: { data: unknown }) {
  const fields = submissionExtras(data);
  if (fields.length === 0) return null;
  return (
    <dl className="mt-1 space-y-0.5 text-[11px]">
      {fields.map((f) => (
        <div key={f.key} className="flex gap-1.5 min-w-0">
          <dt className="shrink-0 text-muted-foreground">{f.label}:</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
