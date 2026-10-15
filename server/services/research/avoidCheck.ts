/**
 * The brief check: generated copy against the research it was written from
 * (Research module, phase 3; owner plan 2026-10-14: "avoid rules are checked
 * on generated copy; a violation keeps a sequence from going out on its own,
 * even in full autonomy").
 *
 * Avoid rules are sentences ("Don't promise an overlay makes a county
 * compliant"), not keywords, so the check is a small AI judgment. The same
 * call also says which of the research's pains the copy speaks to and which
 * lead-with points its first message opens on (phase 6, "learning from
 * results": the sector page shows which of them get replies).
 *
 * It runs only when the matched research has avoid rules, pains or lead-with
 * points: a workspace without research pays nothing and nothing changes. A
 * check that cannot run (no model, a parse failure) does not hold the copy:
 * the rules make copy better, and a broken judge must not stop every
 * campaign; the failure is logged by the caller.
 */
import { invokeLLM } from "../../_core/llm";
import { researchContextFor, type ResearchContext, type ResearchUse } from "./context";

export type AvoidViolation = { rule: string; quote: string };
export type BriefCheck = {
  checked: boolean;
  rules: number;
  violations: AvoidViolation[];
  /** The research's pains the copy speaks to, as written in the research. */
  pains: string[];
  /** The lead-with points the first message opens on. */
  leads: string[];
  sectorId: number | null;
  personaId: number | null;
  matchedBy: ResearchContext["matchedBy"];
  error?: string;
};

type Step = { subject?: unknown; body?: unknown; channel?: unknown };

export function copyText(steps: Step[]): string {
  return steps
    .map((s, i) => [`Step ${i + 1}${s.channel ? ` (${String(s.channel)})` : ""}`, s.subject ? `Subject: ${String(s.subject)}` : "", String(s.body ?? "")].filter(Boolean).join("\n"))
    .join("\n\n---\n\n")
    .slice(0, 24_000);
}

/** One line for a hold: which rule, and the words that broke it. */
export function holdReason(v: AvoidViolation[]): string {
  if (!v.length) return "";
  const first = v[0];
  const more = v.length > 1 ? ` (and ${v.length - 1} more)` : "";
  return `Breaks your research's avoid rule "${first.rule}"${first.quote ? `: "${first.quote}"` : ""}${more}`.slice(0, 500);
}

const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");

/** The listed items a model named by number (1-based), each once, in list order. */
function picked(list: string[], raw: unknown): string[] {
  const nums = new Set((Array.isArray(raw) ? raw : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length));
  return list.filter((_, i) => nums.has(i + 1));
}

export async function checkBrief(workspaceId: number, use: Omit<ResearchUse, "surface">, steps: Step[]): Promise<BriefCheck> {
  const ctx = await researchContextFor(workspaceId, { ...use, surface: "judge" });
  const { avoid: rules, pains, leadWith } = ctx;
  const base = { rules: rules.length, violations: [], pains: [], leads: [], sectorId: ctx.sectorId, personaId: ctx.personaId, matchedBy: ctx.matchedBy };
  if (!rules.length && !pains.length && !leadWith.length) return { checked: false, ...base };
  try {
    const parts = [
      rules.length ? `Rules (never say or imply):\n${numbered(rules)}` : "",
      pains.length ? `Pains:\n${numbered(pains)}` : "",
      leadWith.length ? `Lead-with points:\n${numbered(leadWith)}` : "",
      `Copy:\n${copyText(steps)}`,
    ].filter(Boolean);
    const res = await invokeLLM({
      workspaceId,
      maxTokens: 1500,
      messages: [
        {
          role: "system",
          content:
            "You check sales copy against the research it was written from. " +
            "Rules: report a rule only when the copy clearly breaks it, quoting the exact words that do. " +
            "Mentioning a topic the rule is about is not a break; making the claim the rule forbids is. " +
            "If nothing breaks a rule, return an empty list. " +
            "Pains: give the numbers of the pains the copy speaks to, by name or plainly by meaning. " +
            "Lead-with points: give the numbers of the points the FIRST step opens on. " +
            "Return empty lists when none apply or a list is not given.",
        },
        { role: "user", content: parts.join("\n\n") },
      ],
      outputSchema: {
        name: "brief_check",
        schema: {
          type: "object",
          properties: {
            violations: {
              type: "array",
              items: { type: "object", properties: { rule: { type: "string" }, quote: { type: "string" } }, required: ["rule", "quote"] },
            },
            pains: { type: "array", items: { type: "integer" } },
            leads: { type: "array", items: { type: "integer" } },
          },
          required: ["violations", "pains", "leads"],
        },
      },
    });
    const raw = res.choices[0]?.message?.content;
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}") as { violations?: unknown; pains?: unknown; leads?: unknown };
    const violations = rules.length
      ? (Array.isArray(parsed.violations) ? parsed.violations : [])
          .filter((v): v is { rule: unknown; quote: unknown } => !!v && typeof v === "object")
          .map((v) => ({ rule: String(v.rule ?? "").trim().slice(0, 300), quote: String(v.quote ?? "").trim().slice(0, 200) }))
          .filter((v) => v.rule)
      : [];
    return { ...base, checked: true, violations, pains: picked(pains, parsed.pains), leads: picked(leadWith, parsed.leads) };
  } catch (e) {
    return { ...base, checked: false, error: e instanceof Error ? e.message : String(e) };
  }
}
