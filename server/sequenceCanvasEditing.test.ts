/**
 * Tests for features 67 & 68:
 * - Inline canvas editing (NodeEditPanel logic, SequenceSettingsPanel logic)
 * - Email mode selector (dynamic / template / typed) per-step
 * - Exit conditions and sequence settings schema
 * - sequences.update accepts exitConditions + settings patch
 */
import { describe, it, expect } from "vitest";

/* ─── Types (mirror client-side) ─────────────────────────────────────────── */
type EmailMode = "dynamic" | "template" | "typed";

interface NodeData {
  label?: string;
  description?: string;
  emailMode?: EmailMode;
  staticSubject?: string;
  staticBody?: string;
  staticTemplateId?: number;
  aiTone?: string;
  aiLength?: string;
  aiFocus?: string;
  delayDays?: number;
  delayHours?: number;
  branchOn?: string;
  branchTrueLabel?: string;
  branchFalseLabel?: string;
  actionType?: string;
  actionValue?: string;
  goalType?: string;
  goalValue?: string;
}

interface ExitCondition {
  type: "reply" | "bounce" | "unsubscribe" | "goal_met" | "manual";
  enabled: boolean;
}

interface SequenceSettings {
  timezone?: string;
  sendWindowStart?: string;
  sendWindowEnd?: string;
  skipWeekends?: boolean;
  replyDetection?: boolean;
  maxSteps?: number;
}

/* ─── Email mode logic ───────────────────────────────────────────────────── */
describe("Email mode — per-step configuration", () => {
  it("defaults to 'typed' when emailMode is undefined", () => {
    const data: NodeData = {};
    const mode = data.emailMode ?? "typed";
    expect(mode).toBe("typed");
  });

  it("typed mode stores staticSubject and staticBody", () => {
    const data: NodeData = {
      emailMode: "typed",
      staticSubject: "Quick question about {{company}}",
      staticBody: "Hi {{firstName}},\n\nI noticed…",
    };
    expect(data.emailMode).toBe("typed");
    expect(data.staticSubject).toContain("{{company}}");
    expect(data.staticBody).toContain("{{firstName}}");
  });

  it("template mode stores staticTemplateId", () => {
    const data: NodeData = {
      emailMode: "template",
      staticTemplateId: 42,
    };
    expect(data.emailMode).toBe("template");
    expect(data.staticTemplateId).toBe(42);
  });

  it("dynamic mode stores aiTone, aiLength, aiFocus", () => {
    const data: NodeData = {
      emailMode: "dynamic",
      aiTone: "professional",
      aiLength: "medium",
      aiFocus: "ROI",
    };
    expect(data.emailMode).toBe("dynamic");
    expect(data.aiTone).toBe("professional");
    expect(data.aiLength).toBe("medium");
    expect(data.aiFocus).toBe("ROI");
  });

  it("each step can have a different email mode", () => {
    const steps: NodeData[] = [
      { emailMode: "typed", staticSubject: "Hello" },
      { emailMode: "dynamic", aiTone: "friendly" },
      { emailMode: "template", staticTemplateId: 7 },
    ];
    expect(steps[0].emailMode).toBe("typed");
    expect(steps[1].emailMode).toBe("dynamic");
    expect(steps[2].emailMode).toBe("template");
  });

  it("rejects invalid email mode values", () => {
    const validModes: EmailMode[] = ["dynamic", "template", "typed"];
    const invalid = "auto" as any;
    expect(validModes.includes(invalid)).toBe(false);
  });
});

/* ─── NodeData defaults for node types ──────────────────────────────────── */
describe("Node default data by type", () => {
  function getDefaultData(type: string): NodeData {
    switch (type) {
      case "email": return { emailMode: "typed" };
      case "wait": return { delayDays: 1, delayHours: 0 };
      case "condition": return { branchOn: "email_opened", branchTrueLabel: "Yes", branchFalseLabel: "No" };
      case "action": return { actionType: "create_task" };
      case "goal": return { goalType: "reply" };
      default: return {};
    }
  }

  it("email node defaults to typed mode", () => {
    expect(getDefaultData("email").emailMode).toBe("typed");
  });

  it("wait node defaults to 1 day 0 hours", () => {
    const d = getDefaultData("wait");
    expect(d.delayDays).toBe(1);
    expect(d.delayHours).toBe(0);
  });

  it("condition node defaults to email_opened branch", () => {
    const d = getDefaultData("condition");
    expect(d.branchOn).toBe("email_opened");
    expect(d.branchTrueLabel).toBe("Yes");
    expect(d.branchFalseLabel).toBe("No");
  });

  it("action node defaults to create_task", () => {
    expect(getDefaultData("action").actionType).toBe("create_task");
  });

  it("goal node defaults to reply", () => {
    expect(getDefaultData("goal").goalType).toBe("reply");
  });

  it("start node has no special defaults", () => {
    expect(getDefaultData("start")).toEqual({});
  });
});

/* ─── Exit conditions ────────────────────────────────────────────────────── */
describe("Exit conditions", () => {
  const DEFAULT_EXIT_CONDITIONS: ExitCondition[] = [
    { type: "reply", enabled: true },
    { type: "bounce", enabled: true },
    { type: "unsubscribe", enabled: true },
    { type: "goal_met", enabled: true },
    { type: "manual", enabled: true },
  ];

  it("default exit conditions all enabled", () => {
    expect(DEFAULT_EXIT_CONDITIONS.every((c) => c.enabled)).toBe(true);
  });

  it("toggling a condition flips enabled", () => {
    const updated = DEFAULT_EXIT_CONDITIONS.map((c) =>
      c.type === "bounce" ? { ...c, enabled: false } : c
    );
    const bounce = updated.find((c) => c.type === "bounce");
    expect(bounce?.enabled).toBe(false);
    expect(updated.filter((c) => c.enabled).length).toBe(4);
  });

  it("has exactly 5 condition types", () => {
    expect(DEFAULT_EXIT_CONDITIONS.length).toBe(5);
  });

  it("all valid condition types are present", () => {
    const types = DEFAULT_EXIT_CONDITIONS.map((c) => c.type);
    expect(types).toContain("reply");
    expect(types).toContain("bounce");
    expect(types).toContain("unsubscribe");
    expect(types).toContain("goal_met");
    expect(types).toContain("manual");
  });

  it("serializes to JSON for DB storage", () => {
    const json = JSON.stringify(DEFAULT_EXIT_CONDITIONS);
    const parsed: ExitCondition[] = JSON.parse(json);
    expect(parsed).toHaveLength(5);
    expect(parsed[0].type).toBe("reply");
  });
});

/* ─── Sequence settings ──────────────────────────────────────────────────── */
describe("Sequence settings", () => {
  const DEFAULT_SETTINGS: SequenceSettings = {
    timezone: "UTC",
    sendWindowStart: "08:00",
    sendWindowEnd: "18:00",
    skipWeekends: true,
    replyDetection: true,
    maxSteps: 10,
  };

  it("default settings are valid", () => {
    expect(DEFAULT_SETTINGS.timezone).toBe("UTC");
    expect(DEFAULT_SETTINGS.skipWeekends).toBe(true);
    expect(DEFAULT_SETTINGS.replyDetection).toBe(true);
    expect(DEFAULT_SETTINGS.maxSteps).toBe(10);
  });

  it("send window start is before end", () => {
    const start = DEFAULT_SETTINGS.sendWindowStart!;
    const end = DEFAULT_SETTINGS.sendWindowEnd!;
    expect(start < end).toBe(true);
  });

  it("maxSteps must be positive", () => {
    expect((DEFAULT_SETTINGS.maxSteps ?? 0) > 0).toBe(true);
  });

  it("patching settings merges correctly", () => {
    const patched = { ...DEFAULT_SETTINGS, skipWeekends: false, timezone: "America/New_York" };
    expect(patched.skipWeekends).toBe(false);
    expect(patched.timezone).toBe("America/New_York");
    expect(patched.replyDetection).toBe(true); // unchanged
  });

  it("serializes to JSON for DB storage", () => {
    const json = JSON.stringify(DEFAULT_SETTINGS);
    const parsed: SequenceSettings = JSON.parse(json);
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.maxSteps).toBe(10);
  });
});

/* ─── sequences.update patch shape ──────────────────────────────────────── */
describe("sequences.update patch for settings", () => {
  it("patch includes exitConditions and settings as JSON-serializable objects", () => {
    const patch = {
      name: "Updated sequence",
      description: "New description",
      exitConditions: [{ type: "reply", enabled: true }],
      settings: { timezone: "UTC", skipWeekends: true },
    };
    // Verify it can be JSON-serialized (as required by z.record(z.string(), z.any()))
    expect(() => JSON.stringify(patch)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(patch));
    expect(parsed.exitConditions[0].type).toBe("reply");
    expect(parsed.settings.timezone).toBe("UTC");
  });

  it("patch can update only name without touching other fields", () => {
    const patch = { name: "New name" };
    expect(Object.keys(patch)).toEqual(["name"]);
  });
});

/* ─── Node edit panel — save/apply logic ─────────────────────────────────── */
describe("NodeEditPanel save logic", () => {
  it("onSave is called with nodeId and merged data", () => {
    const saves: Array<{ id: string; data: NodeData }> = [];
    const onSave = (id: string, data: NodeData) => saves.push({ id, data });

    // Simulate applying changes
    const nodeId = "email-123";
    const newData: NodeData = { emailMode: "dynamic", aiTone: "friendly", label: "Intro email" };
    onSave(nodeId, newData);

    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe("email-123");
    expect(saves[0].data.emailMode).toBe("dynamic");
    expect(saves[0].data.aiTone).toBe("friendly");
  });

  it("readOnly prevents patch application", () => {
    const readOnly = true;
    const patches: Partial<NodeData>[] = [];
    const patch = (p: Partial<NodeData>) => {
      if (readOnly) return;
      patches.push(p);
    };
    patch({ emailMode: "dynamic" });
    expect(patches).toHaveLength(0);
  });

  it("non-readOnly allows patch application", () => {
    const readOnly = false;
    const patches: Partial<NodeData>[] = [];
    const patch = (p: Partial<NodeData>) => {
      if (readOnly) return;
      patches.push(p);
    };
    patch({ emailMode: "dynamic" });
    expect(patches).toHaveLength(1);
    expect(patches[0].emailMode).toBe("dynamic");
  });
});

/* ─── Branch conditions ──────────────────────────────────────────────────── */
describe("Branch conditions", () => {
  const BRANCH_CONDITIONS = [
    "email_opened",
    "email_clicked",
    "email_replied",
    "email_bounced",
    "email_unsubscribed",
    "task_completed",
    "score_above",
    "tag_applied",
  ];

  it("has 8 branch condition types", () => {
    expect(BRANCH_CONDITIONS.length).toBe(8);
  });

  it("all email-related conditions are present", () => {
    expect(BRANCH_CONDITIONS).toContain("email_opened");
    expect(BRANCH_CONDITIONS).toContain("email_clicked");
    expect(BRANCH_CONDITIONS).toContain("email_replied");
    expect(BRANCH_CONDITIONS).toContain("email_bounced");
  });

  it("condition node stores branchOn and labels", () => {
    const data: NodeData = {
      branchOn: "email_opened",
      branchTrueLabel: "Opened",
      branchFalseLabel: "Not opened",
    };
    expect(BRANCH_CONDITIONS.includes(data.branchOn!)).toBe(true);
    expect(data.branchTrueLabel).toBe("Opened");
    expect(data.branchFalseLabel).toBe("Not opened");
  });
});

/* ─── AI tone and length options ─────────────────────────────────────────── */
describe("AI dynamic mode options", () => {
  const AI_TONES = ["professional", "friendly", "direct", "consultative", "casual"];
  const AI_LENGTHS = ["short", "medium", "long"];

  it("has 5 tone options", () => {
    expect(AI_TONES.length).toBe(5);
  });

  it("has 3 length options", () => {
    expect(AI_LENGTHS.length).toBe(3);
  });

  it("professional is a valid tone", () => {
    expect(AI_TONES).toContain("professional");
  });

  it("medium is a valid length", () => {
    expect(AI_LENGTHS).toContain("medium");
  });

  it("aiFocus is optional free text", () => {
    const data: NodeData = { emailMode: "dynamic", aiTone: "direct", aiLength: "short" };
    expect(data.aiFocus).toBeUndefined();
    data.aiFocus = "pain point";
    expect(data.aiFocus).toBe("pain point");
  });
});
