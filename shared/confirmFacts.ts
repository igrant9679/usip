/**
 * What a confirmation says, as typed facts rather than free text (audit
 * 2026-10-20, U5 and X1.8: "one confirmation component that states the
 * count, cost and consequence of every send, spend, delete and bulk change").
 *
 * The confirm dialog (`confirmAction` / `ConfirmButton` in
 * client/src/components/usip/Common.tsx) takes three optional facts next to
 * its title:
 *
 *   count        how many records or messages the action touches — a number,
 *                never "these" or "all"
 *   cost         what it spends, from @shared/spendPreview (vendor credits in
 *                the vendor's unit, AI calls, or nothing)
 *   consequence  what happens after: gone for good, undoable and how, sent and
 *                beyond recall, stopped, or someone loses access
 *
 * Each becomes one sentence under the description. A caller states facts and
 * this module words them, so the same thing reads the same way on every
 * screen, and a test can read every sentence.
 *
 * Pure: no React, no tRPC.
 */
import { costText, type Cost } from "./spendPreview";

const n = (v: number) => v.toLocaleString("en-US");

/** How many the action touches: `{ n: 12, one: "person", many: "people" }`. */
export type ConfirmCount = {
  n: number;
  /** The noun for one ("draft", "person"). */
  one: string;
  /** The noun for several; `one + "s"` when left out. */
  many?: string;
  /** `n` is a ceiling ("up to 500 contacts"), not the exact number. */
  upTo?: boolean;
};

export function countNoun(c: ConfirmCount): string {
  return `${n(c.n)} ${c.n === 1 ? c.one : c.many ?? `${c.one}s`}`;
}

/** "This applies to 12 people." */
export function countLine(c: ConfirmCount): string {
  return `This applies to ${c.upTo ? "up to " : ""}${countNoun(c)}.`;
}

export type SendChannel = "email" | "LinkedIn message" | "LinkedIn invitation" | "calendar invitation" | "report email";

/** What happens after the person says yes. */
export type Consequence =
  /** Deleted for good. `what` names it when the title does not ("Its stored values"). */
  | { kind: "permanent"; what?: string }
  /** Can be put back; `undo` says where ("Restore it from People → Archived"). */
  | { kind: "reversible"; undo: string }
  /** Messages leave now; `n` of them on `channel`. */
  | { kind: "sends"; channel: SendChannel; n: number }
  /** A run in progress stops; `kept` says what survives ("Results so far are kept"). */
  | { kind: "stops"; what: string; kept?: string }
  /** Someone or something loses access straight away; `many` when `who` is plural. */
  | { kind: "access"; who: string; many?: boolean };

const plural = (k: number, w: string) => `${n(k)} ${w}${k === 1 ? "" : "s"}`;

export function consequenceLine(c: Consequence): string {
  switch (c.kind) {
    case "permanent":
      return c.what ? `${c.what} is deleted for good. This cannot be undone.` : "This cannot be undone.";
    case "reversible":
      return `You can undo this: ${c.undo.replace(/\.$/, "")}.`;
    case "sends":
      return c.n === 0
        ? "Nothing is sent."
        : `${plural(c.n, c.channel)} ${c.n === 1 ? "goes" : "go"} out now, subject to the workspace's outbound pause and send caps. A sent message cannot be recalled.`;
    case "stops":
      return `${c.what} stops now.${c.kept ? ` ${c.kept.replace(/\.$/, "")}.` : ""}`;
    case "access":
      return `${c.who} ${c.many ? "lose" : "loses"} access straight away.`;
  }
}

export type ConfirmFacts = {
  count?: ConfirmCount;
  cost?: Cost;
  consequence?: Consequence;
};

/** The sentences a confirm dialog shows under its description, in order. */
export function confirmFactLines(f: ConfirmFacts): string[] {
  const out: string[] = [];
  if (f.count) out.push(countLine(f.count));
  if (f.cost) out.push(costText(f.cost));
  if (f.consequence) out.push(consequenceLine(f.consequence));
  return out;
}
