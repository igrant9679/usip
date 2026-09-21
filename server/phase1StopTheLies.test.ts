/**
 * Phase 1 of the seams audit (owner: "start with phase 1", 2026-09-02):
 * "stop the lies". Every pin here is a place the app used to say something
 * untrue — a dial that changed nothing, a rail item that launched nothing,
 * an aggregator that omitted four queues, an analytics page blind to the
 * engine that sends most of the mail. Source pins keep each truth in place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

describe("navigation tells the product story", () => {
  const registry = client("lib", "toolRegistry.ts");
  const shell = client("components", "usip", "Shell.tsx");

  it("groups are the seven products plus the three cross-cutting groups", () => {
    for (const g of ["Prospecting", "CRM", "Outreach", "Marketing", "Proposals", "Dialer", "Customer Success", "Daily", "Analytics", "Configuration"]) {
      expect(registry).toContain(`"${g}",`);
    }
    for (const dead of ['"Engage"', '"Win deals"', '"Autopilot & AI"', '"Customer success"', '"Analytics & reporting"', '"Inbound"']) {
      expect(registry).not.toContain(dead);
    }
  });

  it("the unfinished Broadcasts product is off the rail but still reachable", () => {
    const row = registry.slice(registry.indexOf('href: "/campaigns"'), registry.indexOf("}", registry.indexOf('href: "/campaigns"')));
    expect(row).toContain('group: "Marketing"');
    expect(row).not.toContain("primary: true");
    expect(row).toContain("Not yet sending");
  });

  it("Customer Success holds Customers, Renewals and QBRs; Help Center is configuration", () => {
    for (const href of ['"/customers"', '"/renewals"', '"/qbrs"']) {
      const row = registry.slice(registry.indexOf(`href: ${href}`), registry.indexOf("}", registry.indexOf(`href: ${href}`)));
      expect(row, href).toContain('group: "Customer Success"');
    }
    const help = registry.slice(registry.indexOf('href: "/help"'), registry.indexOf("}", registry.indexOf('href: "/help"')));
    expect(help).toContain('group: "Configuration"');
  });

  it("the rail renders the product sections, in story order, with no Marketing section", () => {
    const meta = shell.slice(shell.indexOf("const GROUP_META"), shell.indexOf("const EXTRA_GROUP_COLORS"));
    const order = ["Prospecting", "CRM", "Outreach", "Proposals", "Dialer", "Customer Success"].map((g) => meta.indexOf(`group: "${g}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(meta).not.toContain('group: "Marketing"');
  });
});

describe("the Autonomy Center's engine dial is real", () => {
  const page = client("pages", "usip", "WorkflowsV2.tsx");
  const router = read("routers", "are", "campaigns.ts");

  it("one server call sets every campaign and the default", () => {
    expect(router).toContain("setAllAutonomy: adminWsProcedure");
    expect(router).toContain("db.update(areCampaigns)");
    expect(router).toContain("areDefaultAutonomyMode: input.mode");
  });

  it("the dial and both bulk setters go through it", () => {
    expect(page).toContain("trpc.are.campaigns.setAllAutonomy.useMutation");
    expect(page).toContain('onValueChange={(v) => setAllEngineAutonomy.mutate({ mode: v as "full" | "batch_approval" })}');
    const setAll = page.slice(page.indexOf("const setAll = "), page.indexOf("const turnOnFullAutonomy"));
    expect(setAll).toContain('setAllEngineAutonomy.mutate({ mode: "batch_approval" })');
    const full = page.slice(page.indexOf("const turnOnFullAutonomy"), page.indexOf("const areSettings = "));
    expect(full).toContain('setAllEngineAutonomy.mutate({ mode: "batch_approval" })');
  });

  it("review & release is offered nowhere and handled explicitly in the engine", () => {
    for (const f of [page, client("pages", "usip", "ARECampaigns.tsx"), client("pages", "usip", "ARECampaignDetail.tsx"), client("pages", "usip", "ARESettings.tsx")]) {
      expect(f).not.toMatch(/value[:=]\s*"review_release"/);
    }
    const engine = read("areEngine.ts");
    expect(engine).not.toContain("// review_release: leave everything 'pending' for individual review");
    expect(engine).toContain("rows that still carry the value get batch_approval's screening");
    expect(read("services", "assistantTools.ts")).not.toContain('"review_release"');
  });

  it("no surface promises a confidence floor that nothing enforces", () => {
    expect(page).not.toContain("score &amp; confidence");
    expect(client("pages", "usip", "EmailsV2.tsx")).not.toContain("and confidence ≥");
    // /ai-pipeline retired 2026-09-15 — its replacement drawer must not
    // resurrect the unenforced-floor copy either.
    expect(client("components", "usip", "emails", "DraftEditorTools.tsx")).not.toContain("is not yet enforced");
  });

  it("Job Change Autopilot says when it actually runs", () => {
    expect(page).toContain("no schedule of its own");
  });
});

describe("settings the engine actually reads", () => {
  it("the ARE dispatcher consults the workspace open-tracking preference", () => {
    const engine = read("areEngine.ts");
    expect(engine).toContain("workspaceSettings.emailOpenTracking");
    expect(engine).toContain("open: openTrackingPref,");
    expect(engine).not.toMatch(/open: true,\s*\n\s*click: false,/);
  });

  it("the workflow API only accepts triggers that fire", () => {
    const ops = read("routers", "operations.ts");
    expect(ops).toMatch(/import \{ LIVE_TRIGGER_IDS[^}]*\} from "@shared\/workflowTriggers"/);
    expect(ops).toContain("triggerType: z.enum(LIVE_TRIGGER_IDS as unknown as [LiveTrigger, ...LiveTrigger[]])");
    expect(ops).not.toContain('"nps_submitted", "signal_received", "field_equals", "schedule"');
  });
});

describe("the engine never offers a channel it cannot send on", () => {
  // 2026-09-20. ARE Settings and the campaign wizard offered SMS and AI Voice
  // as ordinary toggles; turning one on wrote steps into are_execution_queue
  // that nothing has ever been able to deliver (no SMS gateway anywhere in
  // the repo; voiceBridge exports answerInboundCall and nothing else). Those
  // steps are skipped, skipped > sent reads as "abandoned", and the prospect
  // is cancelled with "re-approve to re-enrol" — which regenerates from the
  // same cached template and cancels again, forever.
  const settings = client("pages", "usip", "ARESettings.tsx");
  const campaigns = client("pages", "usip", "ARECampaigns.tsx");
  const detail = client("pages", "usip", "ARECampaignDetail.tsx");
  const dossier = client("components", "usip", "are", "IntelligenceDossier.tsx");
  const prospects = read("routers", "are", "prospects.ts");

  it("ARE Settings marks SMS and AI Voice unsendable and disables them", () => {
    const opts = settings.slice(settings.indexOf("const CHANNEL_OPTIONS"), settings.indexOf("];", settings.indexOf("const CHANNEL_OPTIONS")));
    expect(opts).toMatch(/key: "sms"[^}]*sendable: false/);
    expect(opts).toMatch(/key: "voice"[^}]*sendable: false/);
    expect(opts).toMatch(/key: "email"[^}]*sendable: true/);
    expect(opts).toMatch(/key: "linkedin"[^}]*sendable: true/);
    expect(settings).toContain("disabled={!sendable}");
    // Derived at the read — a row already holding sms:true renders off
    // WITHOUT this page rewriting the workspace's stored settings.
    expect(settings).toContain("const active = !!channels[key] && sendable;");
  });

  it("the campaign wizard disables them too, and no longer mislabels LinkedIn", () => {
    expect(campaigns).toContain("disabled={!isSendableChannel(ch)}");
    expect(campaigns).toContain("checked={form.channelsEnabled[ch] && isSendableChannel(ch)}");
    // LinkedIn has been wired and sending since 2026-08-15.
    expect(campaigns).not.toContain('{ch !== "email" && <span');
    expect(campaigns).not.toContain("v1 engine sends email only");
  });

  it("both sequence viewers say a step will not send", () => {
    for (const [name, src] of [["ARECampaignDetail", detail], ["IntelligenceDossier", dossier]] as const) {
      expect(src, name).toContain("isSendableChannel");
      expect(src, name).toContain("will not send");
    }
  });

  it("the enrichment prompt no longer asks the model to recommend SMS or a phone call", () => {
    expect(prospects).not.toContain("(email/linkedin/sms/voice)");
    expect(prospects).toContain("email or linkedin ONLY");
  });

  it("the sequence-architect prompt is built from the sendable subset", () => {
    expect(prospects).toContain("const sendableChannels = ARE_SENDABLE_CHANNELS.filter(");
    expect(prospects).toContain("## Channels enabled\\n${JSON.stringify(sendableChannels.length ? sendableChannels : [\"email\"])}");
    expect(prospects).not.toContain("JSON.stringify(campaign.channelsEnabled)");
  });

  it("the clamp sits at BOTH returns of generateCampaignTemplate, cached one included", () => {
    // The cached branch is the one that matters: a prompt-only fix leaves
    // every campaign that already has a generatedTemplate minting unsendable
    // queue rows forever.
    expect(prospects.match(/return clampTemplateChannels\(/g) ?? []).toHaveLength(2);
    expect(prospects).toContain("if (cached && Array.isArray(cached.steps) && cached.steps.length > 0) return clampTemplateChannels(cached);");
    // Stored history stays raw — the clamp is applied at the read.
    expect(prospects).toContain("generatedTemplate: template, generatedTemplateAt: new Date()");
  });

  it("the per-prospect writer cannot reintroduce one either", () => {
    const fn = prospects.slice(prospects.indexOf("async function personalizeForProspect"), prospects.indexOf("export async function runSequenceAgent"));
    expect(fn).toContain('const channel = isSendableChannel(s.channel) ? String(s.channel).toLowerCase() : "email";');
    expect(fn).toContain("return { ...s, channel, body, variantKey: DEFAULT_VARIANT_KEY };");
  });
});

describe("numbers that used to omit the engine", () => {
  it("the attention aggregator counts all nine queues", () => {
    const att = read("routers", "attention.ts");
    for (const k of ["sequenceDrafts", "socialReplies", "optimizationRecs", "chatFollowUps"]) {
      expect(att).toContain(`${k}.count`);
    }
    // Since 2026-09-20 the draft cards use the FEED's vocabulary (flags,
    // not status strings) — see draftVocabulary.test.ts for the full pin.
    expect(att).toContain('inArray(emailDrafts.status, ["pending_review", "ai_pending_review"])');
    expect(att).toContain("isNull(unipileMessages.handledAt)");
    expect(att).toContain("optimizationRecommendations.status");
    expect(att).toContain('like(tasks.title, "Follow up:%")');
    const panel = client("components", "usip", "AttentionPanel.tsx");
    for (const k of ["sequenceDrafts", "socialReplies", "optimizationRecs", "chatFollowUps"]) expect(panel).toContain(`s.${k}`);
  });

  it("Email Analytics counts campaign sends", () => {
    const smtp = read("routers", "smtpConfig.ts");
    expect(smtp).toContain("from(areExecutionQueue)");
    expect(smtp).toContain("const totalSent = allSent.length + areSent;");
  });

  it("Dashboards' two stage ratios are named as stage ratios", () => {
    const dash = client("pages", "usip", "Dashboards.tsx");
    expect(dash).toContain('label: "Opportunities with activity %"');
    expect(dash).toContain('label: "Opportunities past proposal stage %"');
    expect(dash).not.toContain('label: "Reply rate %"');
  });
});
