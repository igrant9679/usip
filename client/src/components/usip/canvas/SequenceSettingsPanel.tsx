/**
 * SequenceSettingsPanel — slide-in right panel for editing sequence-level config:
 * - Sequence name and description
 * - What stops a person (said, not toggled: see "What stops someone" below)
 * - Sending settings (timezone, send window, skip weekends, reply detection, max steps)
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabelContext } from "@/components/ui/field-label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Settings2, X } from "lucide-react";
import { TimezonePicker } from "@/components/usip/TimezonePicker";

/* ─── Types ─────────────────────────────────────────────────────────────── */
export interface SequenceSettings {
  timezone?: string;
  sendWindowStart?: string; // "HH:MM" 24h
  sendWindowEnd?: string;
  skipWeekends?: boolean;
  replyDetection?: boolean;
  maxSteps?: number;
}

interface Props {
  open: boolean;
  readOnly: boolean;
  name: string;
  description?: string | null;
  settings: SequenceSettings;
  /** The workspace's zone, named on the picker's default choice. */
  workspaceZone?: string | null;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    description: string;
    settings: SequenceSettings;
  }) => void;
}

/**
 * What stops someone, as the engine does it (audit 2026-10-20, O27). This
 * panel had five "exit condition" switches that were saved and read by
 * nothing, so turning one off changed nothing and turning one on promised a
 * stop that never came. They are gone; this says what really happens.
 */
export const WHAT_STOPS_SOMEONE = [
  "A reply pauses them, while Reply detection below is on.",
  "Unsubscribing, or a do-not-contact entry for their address, LinkedIn profile or company, stops every email and LinkedIn step.",
  "A bounce stops the email steps; their tasks still come up.",
  "You can pause or exit anyone by hand from the sequence's contacts.",
];

/* Every IANA zone, through the shared picker (audit 2026-10-20, U15): this
   listed twelve. No zone of its own means the workspace's (Settings). */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label id={id} className="text-xs">{label}</Label>
      <FieldLabelContext.Provider value={id}>{children}</FieldLabelContext.Provider>
    </div>
  );
}

export function SequenceSettingsPanel({ open, readOnly, name, description, settings, workspaceZone, onClose, onSave }: Props) {
  const [draftName, setDraftName] = React.useState(name);
  const [draftDesc, setDraftDesc] = React.useState(description ?? "");
  const [draftSettings, setDraftSettings] = React.useState<SequenceSettings>(settings);

  // Sync when props change (e.g. after save)
  React.useEffect(() => {
    setDraftName(name);
    setDraftDesc(description ?? "");
    setDraftSettings(settings);
  }, [name, description, settings]);

  if (!open) return null;

  const patchSettings = (p: Partial<SequenceSettings>) => {
    if (readOnly) return;
    setDraftSettings((s) => ({ ...s, ...p }));
  };

  const handleSave = () => {
    onSave({
      name: draftName.trim() || name,
      description: draftDesc,
      settings: draftSettings,
    });
    onClose();
  };

  return (
    <div className="absolute right-0 top-0 h-full w-full sm:w-80 bg-card border-l shadow-xl z-10 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
        <Settings2 className="size-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Sequence settings</span>
        {readOnly && <Badge variant="secondary" className="text-[10px] ml-1">read-only</Badge>}
        <button aria-label="Close" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground transition">
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <Section title="Identity">
          <Field label="Sequence name">
            <Input
              value={draftName}
              disabled={readOnly}
              placeholder="e.g. Cold outreach — SaaS founders"
              onChange={(e) => setDraftName(e.target.value)}
            />
          </Field>
          <Field label="Description (optional)">
            <Input
              value={draftDesc}
              disabled={readOnly}
              placeholder="Internal note about this sequence"
              onChange={(e) => setDraftDesc(e.target.value)}
            />
          </Field>
        </Section>

        <Separator />

        <Section title="What stops someone">
          <ul className="list-disc pl-4 space-y-1 text-[11px] text-muted-foreground">
            {WHAT_STOPS_SOMEONE.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Section>

        <Separator />

        <Section title="Sending window">
          <Field label="Timezone">
            <TimezonePicker
              label="Timezone"
              value={draftSettings.timezone}
              workspaceZone={workspaceZone}
              disabled={readOnly}
              onChange={(zone) => patchSettings({ timezone: zone ?? undefined })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Send from">
              <Input
                type="time"
                value={draftSettings.sendWindowStart ?? "08:00"}
                disabled={readOnly}
                onChange={(e) => patchSettings({ sendWindowStart: e.target.value })}
              />
            </Field>
            <Field label="Send until">
              <Input
                type="time"
                value={draftSettings.sendWindowEnd ?? "18:00"}
                disabled={readOnly}
                onChange={(e) => patchSettings({ sendWindowEnd: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">Skip weekends</span>
            <Switch aria-label="Skip weekends"
              checked={draftSettings.skipWeekends ?? true}
              disabled={readOnly}
              onCheckedChange={(v) => patchSettings({ skipWeekends: v })}
            />
          </div>
        </Section>

        <Separator />

        <Section title="Behaviour">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs">Reply detection</div>
              <div className="text-[11px] text-muted-foreground">Pause someone's enrolment when they reply</div>
            </div>
            <Switch aria-label="Reply detection"
              checked={draftSettings.replyDetection ?? true}
              disabled={readOnly}
              onCheckedChange={(v) => patchSettings({ replyDetection: v })}
            />
          </div>
          <Field label="Max steps per contact">
            <Input
              type="number"
              min={1}
              max={50}
              value={draftSettings.maxSteps ?? 10}
              disabled={readOnly}
              onChange={(e) => patchSettings({ maxSteps: Number(e.target.value) })}
            />
          </Field>
        </Section>
      </div>

      {/* Footer */}
      {!readOnly ? (
        <div className="border-t px-4 py-3 flex gap-2 shrink-0">
          <Button size="sm" className="flex-1" onClick={handleSave}>
            Save settings
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="border-t px-4 py-3 shrink-0">
          <Button size="sm" variant="outline" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

// Need React import for useState/useEffect
import React from "react";
