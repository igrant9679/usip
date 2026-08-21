/**
 * "New enrichment job" builder — a right slide-over on the Data Enrichment
 * page (owner ask 2026-08-21, built to a reference screenshot).
 *
 * Composition, not a monolith: JobStepNav (Workflow ↔ Settings), a dotted
 * workflow canvas of WorkflowStage + ActionCard, CardPickerDialog for each
 * card's choice, JobDrawerFooter for the gated primary action, and the pure
 * gating rules in ./jobFlow (which card unlocks when, what "complete" means).
 *
 * The shell is the app's Sheet (Radix dialog): dimmed overlay, Escape close,
 * focus trap, aria-modal + labelled title, background scroll lock — none of
 * it re-implemented here. Config state lives in THIS component, above the
 * sheet content, so selections survive Workflow ↔ Settings switches and an
 * accidental close/reopen.
 *
 * ⚠️ Deliberately not wired to a backend: no enrichment-jobs table or
 * procedure exists yet (the header's "View scheduled jobs 0" reads a page
 * that lists none). The Settings step says so and its Create button stays
 * disabled with the reason — clearly isolated local state, no fake save.
 */
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionCard } from "./ActionCard";
import { CardPickerDialog } from "./CardPickerDialog";
import { JobDrawerFooter } from "./JobDrawerFooter";
import { JobStepNav } from "./JobStepNav";
import { StageConnector, WorkflowStage } from "./WorkflowStage";
import {
  EMPTY_JOB, cardCompleted, cardEnabled, labelFor, optionsFor, selectedValue,
  withSelection, workflowComplete, type CardKey, type EnrichmentJobConfig, type JobStep,
} from "./jobFlow";

const CARD_TITLES: Record<CardKey, string> = {
  object: "Define object to enrich",
  type: "Select enrichment type",
  filters: "Set filters (Optional)",
  cadence: "Set cadence",
};

const PICKER_TITLES: Record<CardKey, string> = {
  object: "What should this job enrich?",
  type: "Which enrichment should run?",
  filters: "Which records should it touch?",
  cadence: "How often should it run?",
};

export function EnrichmentJobDrawer({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<JobStep>("workflow");
  const [cfg, setCfg] = useState<EnrichmentJobConfig>(EMPTY_JOB);
  const [picker, setPicker] = useState<CardKey | null>(null);
  const complete = workflowComplete(cfg);

  const card = (key: CardKey) => (
    <ActionCard
      label={CARD_TITLES[key]}
      sublabel={labelFor(key, selectedValue(cfg, key))}
      completed={cardCompleted(cfg, key)}
      disabled={!cardEnabled(cfg, key)}
      active={picker === key}
      onClick={() => setPicker(key)}
    />
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* gap-0/p-0 override the sheet's defaults so header/nav/body/footer
          stack edge to edge; sm:max-w-md (not bare max-w-*) beats the
          component's own sm:max-w-sm — the dialog max-w lesson. */}
      <SheetContent side="right" className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-md">
        {/* Header — toggle · title · (the sheet's built-in close X sits at
            top-4 right-4, which this row's pr-12 leaves clear). */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border py-3 pl-4 pr-12">
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => setCfg((c) => ({ ...c, enabled: v === true }))}
            aria-label="Enable this job once created"
          />
          <SheetTitle className="text-[15px] font-semibold tracking-tight">New enrichment job</SheetTitle>
          <SheetDescription className="sr-only">
            Configure what to enrich, how, and on what cadence, then review settings.
          </SheetDescription>
        </div>

        <JobStepNav step={step} onStepChange={setStep} settingsEnabled={complete} />

        {/* Body — the scrolling middle; min-h-0 is load-bearing under the
            flex column (flex-collapse class). */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {step === "workflow" ? (
            <div
              className="min-h-full px-5 py-6"
              style={{
                backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
                backgroundSize: "16px 16px",
              }}
            >
              <WorkflowStage pill="When this happens">
                {card("object")}
              </WorkflowStage>
              <StageConnector />
              <WorkflowStage pill="Then do this action">
                {card("type")}
                {card("filters")}
                {card("cadence")}
              </WorkflowStage>
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <div className="space-y-1.5">
                <Label htmlFor="enrichment-job-name" className="text-xs">Job name</Label>
                <Input
                  id="enrichment-job-name"
                  value={cfg.name}
                  onChange={(e) => setCfg((c) => ({ ...c, name: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
              <div className="rounded-lg border bg-card p-3 text-xs">
                <div className="mb-2 font-medium">Workflow summary</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
                  <dt>Enrich</dt><dd className="text-foreground">{labelFor("object", cfg.objectType) ?? "—"}</dd>
                  <dt>With</dt><dd className="text-foreground">{labelFor("type", cfg.enrichmentType) ?? "—"}</dd>
                  <dt>Filter</dt><dd className="text-foreground">{labelFor("filters", cfg.filter) ?? "All matching records"}</dd>
                  <dt>Cadence</dt><dd className="text-foreground">{labelFor("cadence", cfg.cadence) ?? "—"}</dd>
                  <dt>State</dt><dd className="text-foreground">{cfg.enabled ? "Enabled on create" : "Created paused"}</dd>
                </dl>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Nothing is saved yet — scheduled enrichment jobs have no backend table or runner.
                This builder keeps your configuration locally so the flow can be exercised end to end.
              </p>
            </div>
          )}
        </div>

        {step === "workflow" ? (
          <JobDrawerFooter
            label="Next: Settings"
            disabled={!complete}
            disabledReason="Choose the object, enrichment type and cadence first"
            onClick={() => setStep("settings")}
          />
        ) : (
          <JobDrawerFooter
            label="Create job"
            disabled
            disabledReason="Saving enrichment jobs isn't wired to a backend yet"
            onClick={() => undefined}
            left={<span className="text-[11px] text-muted-foreground">Backend not built — nothing will be saved.</span>}
          />
        )}

        <CardPickerDialog
          open={picker != null}
          title={picker ? PICKER_TITLES[picker] : ""}
          options={picker ? optionsFor(picker) : []}
          value={picker ? selectedValue(cfg, picker) : null}
          onCancel={() => setPicker(null)}
          onApply={(v) => {
            if (picker) setCfg((c) => withSelection(c, picker, v));
            setPicker(null);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
