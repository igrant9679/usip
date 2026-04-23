/**
 * SequenceSettingsPanel — slide-in right panel for editing sequence-level config:
 * - Sequence name and description
 * - Exit conditions (reply, bounce, unsubscribe, goal_met, manual)
 * - Sending settings (timezone, send window, skip weekends, reply detection, max steps)
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Settings2, X } from "lucide-react";

/* ─── Types ─────────────────────────────────────────────────────────────── */
export interface ExitCondition {
  type: "reply" | "bounce" | "unsubscribe" | "goal_met" | "manual";
  enabled: boolean;
}

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
  exitConditions: ExitCondition[];
  settings: SequenceSettings;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    description: string;
    exitConditions: ExitCondition[];
    settings: SequenceSettings;
  }) => void;
}

/* ─── Default exit conditions ───────────────────────────────────────────── */
const DEFAULT_EXIT_CONDITIONS: ExitCondition[] = [
  { type: "reply", enabled: true },
  { type: "bounce", enabled: true },
  { type: "unsubscribe", enabled: true },
  { type: "goal_met", enabled: true },
  { type: "manual", enabled: true },
];

const EXIT_LABELS: Record<string, string> = {
  reply: "Prospect replies",
  bounce: "Email hard bounces",
  unsubscribe: "Prospect unsubscribes",
  goal_met: "Goal node reached",
  manual: "Manually exited",
};

/* ─── Timezone list (abbreviated) ──────────────────────────────────────── */
const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

export function SequenceSettingsPanel({ open, readOnly, name, description, exitConditions, settings, onClose, onSave }: Props) {
  const [draftName, setDraftName] = React.useState(name);
  const [draftDesc, setDraftDesc] = React.useState(description ?? "");
  const [draftExit, setDraftExit] = React.useState<ExitCondition[]>(
    exitConditions.length > 0 ? exitConditions : DEFAULT_EXIT_CONDITIONS
  );
  const [draftSettings, setDraftSettings] = React.useState<SequenceSettings>(settings);

  // Sync when props change (e.g. after save)
  React.useEffect(() => {
    setDraftName(name);
    setDraftDesc(description ?? "");
    setDraftExit(exitConditions.length > 0 ? exitConditions : DEFAULT_EXIT_CONDITIONS);
    setDraftSettings(settings);
  }, [name, description, exitConditions, settings]);

  if (!open) return null;

  const toggleExit = (type: ExitCondition["type"]) => {
    if (readOnly) return;
    setDraftExit((prev) =>
      prev.map((c) => (c.type === type ? { ...c, enabled: !c.enabled } : c))
    );
  };

  const patchSettings = (p: Partial<SequenceSettings>) => {
    if (readOnly) return;
    setDraftSettings((s) => ({ ...s, ...p }));
  };

  const handleSave = () => {
    onSave({
      name: draftName.trim() || name,
      description: draftDesc,
      exitConditions: draftExit,
      settings: draftSettings,
    });
    onClose();
  };

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-card border-l shadow-xl z-10 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
        <Settings2 className="size-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Sequence settings</span>
        {readOnly && <Badge variant="secondary" className="text-[10px] ml-1">read-only</Badge>}
        <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground transition">
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

        <Section title="Exit conditions">
          <p className="text-[11px] text-muted-foreground">
            When any enabled condition is met, the contact is automatically exited from the sequence.
          </p>
          <div className="space-y-2">
            {draftExit.map((cond) => (
              <div key={cond.type} className="flex items-center justify-between gap-2">
                <span className="text-xs">{EXIT_LABELS[cond.type]}</span>
                <Switch
                  checked={cond.enabled}
                  disabled={readOnly}
                  onCheckedChange={() => toggleExit(cond.type)}
                />
              </div>
            ))}
          </div>
        </Section>

        <Separator />

        <Section title="Sending window">
          <Field label="Timezone">
            <Select
              value={draftSettings.timezone ?? "UTC"}
              disabled={readOnly}
              onValueChange={(v) => patchSettings({ timezone: v })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz} className="text-xs">{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Switch
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
              <div className="text-[11px] text-muted-foreground">Auto-exit when a reply is detected</div>
            </div>
            <Switch
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
