/**
 * Checks generated copy against the research's avoid rules (Research module,
 * phase 3; owner plan 2026-10-14: "avoid rules are checked on generated copy;
 * a violation keeps a sequence from going out on its own, even in full
 * autonomy").
 *
 * Avoid rules are sentences ("Don't promise an overlay makes a county
 * compliant"), not keywords, so the check is a small AI judgment. It runs only
 * when the matched research HAS avoid rules: a workspace without research pays
 * nothing and nothing changes. A check that cannot run (no model, a parse
 * failure) does not hold the copy: the rules make copy better, and a broken
 * judge must not stop every campaign; the failure is logged by the caller.
 */
import { invokeLLM } from "../../_core/llm";
import { researchContextFor, type ResearchUse } from "./context";

export type AvoidViolation = { rule: string; quote: string };
export type AvoidCheck = { checked: boolean; rules: number; violations: AvoidViolation[]; error?: string };

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

export async function checkAvoidRules(workspaceId: number, use: Omit<ResearchUse, "surface">, steps: Step[]): Promise<AvoidCheck> {
  const ctx = await researchContextFor(workspaceId, { ...use, surface: "judge" });
  const rules = ctx.avoid;
  if (!rules.length) return { checked: false, rules: 0, violations: [] };
  try {
    const res = await invokeLLM({
      workspaceId,
      maxTokens: 1500,
      messages: [
        {
          role: "system",
          content:
            "You check sales copy against a list of rules about what it must never say or imply. " +
            "Report a rule only when the copy clearly breaks it, quoting the exact words that do. " +
            "Mentioning a topic the rule is about is not a break; making the claim the rule forbids is. " +
            "If nothing breaks a rule, return an empty list.",
        },
        {
          role: "user",
          content: `Rules (never say or imply):\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nCopy:\n${copyText(steps)}`,
        },
      ],
      outputSchema: {
        name: "avoid_check",
        schema: {
          type: "object",
          properties: {
            violations: {
              type: "array",
              items: { type: "object", properties: { rule: { type: "string" }, quote: { type: "string" } }, required: ["rule", "quote"] },
            },
          },
          required: ["violations"],
        },
      },
    });
    const raw = res.choices[0]?.message?.content;
    const parsed = JSON.parse(typeof raw === "string" ? raw : "{}") as { violations?: unknown };
    const violations = (Array.isArray(parsed.violations) ? parsed.violations : [])
      .filter((v): v is { rule: unknown; quote: unknown } => !!v && typeof v === "object")
      .map((v) => ({ rule: String(v.rule ?? "").trim().slice(0, 300), quote: String(v.quote ?? "").trim().slice(0, 200) }))
      .filter((v) => v.rule);
    return { checked: true, rules: rules.length, violations };
  } catch (e) {
    return { checked: false, rules: rules.length, violations: [], error: e instanceof Error ? e.message : String(e) };
  }
}
