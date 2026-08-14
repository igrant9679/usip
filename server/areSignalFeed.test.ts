/**
 * The Signals tab must answer WHO did WHAT, and WHEN (owner ask 2026-08-14).
 *
 * It previously rendered the stored machine vocabulary and nothing else — a
 * type slug, a sentiment word, a short timestamp. The person was one LEFT JOIN
 * away in prospect_queue, the message they acted on another in
 * are_execution_queue, and the specifics (which link was clicked, what the
 * reply said, why it bounced) sat unread in are_signal_log.rawPayload.
 *
 * These tests exercise the real @shared/areSignals module — the thing the page
 * imports — rather than restating its tables, plus two drift checks that a
 * pure unit test cannot make: that the vocabulary covers every enum value the
 * database can store, and that the feed's filters run in SQL rather than over
 * an already-limited page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARE_SIGNALS,
  signalMeta,
  describeSignal,
  actionLabel,
  signalSourceLabel,
  stepLabelFromPayload,
  excerpt,
} from "@shared/areSignals";

const schema = readFileSync("drizzle/schema.ts", "utf8");
const execution = readFileSync("server/routers/are/execution.ts", "utf8");
const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");

/** The signalType enum exactly as are_signal_log declares it. */
function schemaSignalTypes(): string[] {
  const table = schema.slice(schema.indexOf('"are_signal_log"'));
  const enumStart = table.indexOf('mysqlEnum("signalType"');
  const block = table.slice(enumStart, table.indexOf("]).notNull()", enumStart));
  return Array.from(block.matchAll(/"([a-z_]+)"/g))
    .map((m) => m[1])
    .filter((v) => v !== "signalType");
}

describe("every signal type the database can store has a human meaning", () => {
  it("covers the are_signal_log enum with no gaps", () => {
    const stored = schemaSignalTypes();
    expect(stored.length).toBeGreaterThan(10); // the parse found the enum
    const known = new Set(ARE_SIGNALS.map((s) => s.id));
    for (const type of stored) expect(known.has(type as never), type).toBe(true);
  });

  it("gives each type a predicate that reads as a sentence about a person", () => {
    for (const s of ARE_SIGNALS) {
      expect(s.verb.length, s.id).toBeGreaterThan(3);
      // A verb phrase, not a restatement of the slug.
      expect(s.verb, s.id).not.toBe(s.id.replace(/_/g, " "));
    }
  });

  it("attributes engine actions to the engine, not to the prospect", () => {
    // A bounce is produced by the mail system and an auto-created opportunity
    // by Velocity. Rendering either under "<person> did this" is a lie about
    // who acted.
    expect(signalMeta("email_bounce").actor).toBe("system");
    expect(signalMeta("opportunity_created").actor).toBe("system");
    expect(signalMeta("email_reply").actor).toBe("prospect");
  });

  it("degrades to the slug for a type it has not been taught", () => {
    const m = signalMeta("whatsapp_reply");
    expect(m.label).toBe("Whatsapp reply");
    expect(m.tone).toBe("neutral");
  });
});

describe("the payload's facts reach the screen", () => {
  it("surfaces the clicked link as a link", () => {
    const [first] = describeSignal("email_click", { url: "https://acme.com/pricing" });
    expect(first.label).toBe("Link");
    expect(first.href).toBe("https://acme.com/pricing");
  });

  it("surfaces what a reply actually said", () => {
    const details = describeSignal("email_reply", {
      body: "  Thanks — can you   send pricing?\n\n",
      subject: "Re: intro",
      fromEmail: "dana@acme.com",
    });
    const byLabel = Object.fromEntries(details.map((d) => [d.label, d.value]));
    expect(byLabel["What they said"]).toBe("Thanks — can you send pricing?");
    expect(byLabel["Subject"]).toBe("Re: intro");
    expect(byLabel["From"]).toBe("dana@acme.com");
  });

  it("surfaces why a bounce happened", () => {
    const details = describeSignal("email_bounce", { reason: "550 5.1.1 user unknown" });
    expect(details.some((d) => d.label === "Reason" && d.value.includes("550"))).toBe(true);
  });

  it("does not swallow a key it was never taught", () => {
    // A producer that adds a field must not have to edit the renderer for the
    // field to be visible — otherwise "we recorded it" and "you can see it"
    // drift apart silently.
    const details = describeSignal("email_open", { deviceType: "mobile", stepIndex: 1 });
    expect(details.some((d) => d.label === "Device type" && d.value === "mobile")).toBe(true);
  });

  it("keeps key order stable so rows do not reshuffle between renders", () => {
    const a = describeSignal("email_open", { zeta: "1", alpha: "2" }).map((d) => d.label);
    const b = describeSignal("email_open", { alpha: "2", zeta: "1" }).map((d) => d.label);
    expect(a).toEqual(b);
  });

  it("survives a null or non-object payload", () => {
    expect(describeSignal("email_open", null)).toEqual([]);
    expect(describeSignal("email_open", "nope")).toEqual([]);
    expect(describeSignal("email_open", [1, 2])).toEqual([]);
  });

  it("counts steps from 1, like every other tab", () => {
    // stepIndex is zero-based on the wire; the Prospects and Step-performance
    // tabs both show "Step 1" for it.
    expect(stepLabelFromPayload({ stepIndex: 0 })).toBe("Step 1");
    expect(stepLabelFromPayload({ step_index: 2 })).toBe("Step 3");
    expect(stepLabelFromPayload({})).toBeNull();
  });

  it("says how the signal reached us", () => {
    expect(signalSourceLabel({ source: "tracking_pixel" })).toBe("Detected by the open-tracking pixel");
    expect(signalSourceLabel({ source: "autonomous_booking" })).toBe("Booked through Velocity");
    expect(signalSourceLabel({})).toBeNull();
  });

  it("truncates long text on a boundary rather than blowing out the row", () => {
    expect(excerpt("x".repeat(500)).length).toBe(220);
    expect(excerpt("<p>hi <b>there</b></p>")).toBe("hi there");
  });
});

describe("actions are labelled as Velocity's, and silence stays silent", () => {
  it("has a phrase for each slug processSignal writes", () => {
    // Extracted from the writer itself, so a new action can't ship unlabelled.
    const slugs = Array.from(execution.matchAll(/actionTaken = "([a-z_]+)"/g)).map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(4);
    for (const slug of slugs) {
      if (slug === "no_action") continue;
      expect(actionLabel(slug), slug).not.toBe(slug.replace(/_/g, " "));
    }
  });

  it("renders nothing at all for no_action", () => {
    expect(actionLabel("no_action")).toBeNull();
    expect(actionLabel("")).toBeNull();
    expect(actionLabel(null)).toBeNull();
  });
});

describe("the feed reads who and what from the row's neighbours", () => {
  it("joins the prospect and the message it answers", () => {
    const proc = execution.slice(execution.indexOf("getSignalLog:"), execution.indexOf("getSignalCounts:"));
    expect(proc).toContain("leftJoin(prospectQueue");
    expect(proc).toContain("leftJoin(areExecutionQueue");
    // LEFT, not inner: a reply signal carries no executionQueueId at all, and
    // an inner join would drop exactly the signals that matter most.
    expect(proc).not.toContain("innerJoin");
    for (const col of ["firstName", "companyName", "email", "stepIndex", "messageContent"]) {
      expect(proc, col).toContain(`${col}:`);
    }
  });

  it("filters in SQL, not over an already-limited page", () => {
    const proc = execution.slice(execution.indexOf("getSignalLog:"), execution.indexOf("getSignalCounts:"));
    // signalType used to be accepted and never applied — every "filter"
    // returned the unfiltered feed.
    expect(proc).toContain("areSignalLog.signalType, input.signalType");
    expect(proc).toContain("conditions.push");
    const limitAt = proc.indexOf(".limit(");
    const whereAt = proc.indexOf(".where(");
    expect(whereAt).toBeGreaterThan(-1);
    expect(whereAt).toBeLessThan(limitAt);
    expect(proc).toContain("orderBy(desc(areSignalLog.processedAt))");
  });

  it("counts types across the whole campaign, not across the page", () => {
    const proc = execution.slice(execution.indexOf("getSignalCounts:"));
    expect(proc).toContain("groupBy(areSignalLog.signalType)");
    expect(proc.slice(0, proc.indexOf("}),"))).not.toContain(".limit(");
  });

  it("the page renders the person and hands the filters to the server", () => {
    expect(page).toContain('from "@shared/areSignals"');
    // The three questions, on the row.
    expect(page).toContain("SignalRow");
    expect(page).toContain("relativeWhen(s.processedAt)");
    expect(page).toContain("exactWhen(s.processedAt)");
    // Filter state is query input, not a .filter() over fetched rows.
    expect(page).toContain("...(signalType !== \"all\" ? { signalType } : {})");
    expect(page).toContain("search: signalSearchDebounced");
  });
});
