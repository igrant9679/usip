import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { templateWouldReplace, usableTemplates, type EmailStep, type TemplateChoice } from "@/lib/sequenceSteps";
import { useState } from "react";
import { Link } from "wouter";

/**
 * Fill an email step from an Email Builder template. A step with anything in it
 * asks first, because picking replaces its subject and body. `blocked` says why
 * the steps can't be changed right now; the server refuses edits while a
 * sequence is running, and a pick that looked saved would not be.
 */
export function StepTemplatePicker({ step, blocked, onPick }: {
  step: EmailStep;
  blocked: string | null;
  onPick: (template: TemplateChoice) => void;
}) {
  const query = trpc.emailTemplates.list.useQuery({ status: "all" });
  const all = (query.data ?? []) as TemplateChoice[];
  const templates = usableTemplates(all);
  const linked = step.templateId ? all.find((t) => t.id === step.templateId) : undefined;
  const [pending, setPending] = useState<TemplateChoice | null>(null);

  const choose = (id: number) => {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    if (templateWouldReplace(step)) setPending(template);
    else onPick(template);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Use a template"
          className="h-8 max-w-full rounded-md border bg-background px-2 text-xs text-foreground disabled:opacity-60"
          value=""
          disabled={!!blocked || query.isLoading || query.isError || templates.length === 0}
          onChange={(e) => choose(Number(e.target.value))}
        >
          <option value="">
            {query.isLoading ? "Loading templates…" : query.isError ? "Templates could not be loaded" : templates.length === 0 ? "No templates yet" : "Use a template…"}
          </option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name || `Template ${t.id}`}</option>)}
        </select>
        {blocked && <span className="text-[11px] text-muted-foreground">{blocked}</span>}
        {step.templateId && (
          <span className="text-[11px] text-muted-foreground">
            From template:{" "}
            {linked
              ? <Link href={`/email-builder/${linked.id}`} className="font-medium underline-offset-2 hover:underline">{linked.name || `Template ${linked.id}`}</Link>
              : "one you can't open, or that has been deleted"}
          </span>
        )}
      </div>
      {pending && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="min-w-0 flex-1">
            {step.emailMode === "dynamic"
              ? `This step is written by AI when it sends. Using "${pending.name}" sends the template instead.`
              : `Replace this email's subject and body with "${pending.name}"? What's written here will be lost.`}
          </span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { onPick(pending); setPending(null); }}>Use the template</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPending(null)}>Keep what's here</Button>
        </div>
      )}
    </div>
  );
}
