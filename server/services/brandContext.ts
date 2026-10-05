/**
 * buildBrandContext — the seller's OWN company + brand voice, formatted as a
 * prompt section for injection into AI outreach generators.
 *
 * Until now branding was dead-wired: brand_voice_profiles (tone, vocabulary,
 * avoidWords) was never read by any AI path, and there was no store at all for
 * the seller's company facts — every ARE/sequence/email prompt described the
 * PROSPECT's company and never ours, so generated copy couldn't say what we do
 * or in what voice. This helper is the single source that fixes that: every
 * AI outreach writer calls it and prepends the returned block.
 *
 * Sources (all per-workspace):
 *   - workspaces.name                       → company/sender name
 *   - workspace_settings.company*            → description, value prop, industry,
 *                                              website, keywords, topics (migr 0125)
 *   - brand_voice_profiles                   → tone, vocabulary, avoidWords, applyToAI
 *
 *   - the knowledge base (2026-10-05)       → workspace_settings.knowledgeSummary,
 *                                              plus passages matching opts.query
 *
 * The brand_voice_profiles.applyToAI flag (default true) is the master gate
 * for branding: when a workspace turns it OFF, no company or voice block is
 * injected. Product knowledge is facts, not voice, so it still comes along
 * (each document has its own on/off in Settings → Knowledge base).
 * Returns "" (never throws) whenever there's nothing useful to add, so callers
 * can inject unconditionally: `system += brand ? \`\n\n${brand}\` : ""`.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { workspaces, workspaceSettings, brandVoiceProfiles } from "../../drizzle/schema";
import { formatKnowledge } from "./knowledgeText";
import { searchKnowledge } from "./knowledgeSearch";

const asList = (v: unknown, max = 20): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : [];

/**
 * Put the sender's brand into a message list: appended to the first string
 * system message, or as a leading system message when there is none. The
 * mechanism behind InvokeParams.sendersBrand — see _core/llm.ts.
 */
export async function withSendersBrand<M extends { role: string; content: unknown }>(
  workspaceId: number,
  messages: M[],
): Promise<M[]> {
  // The prompt itself is the question put to the knowledge base (2026-10-05):
  // whatever the writer is about, the passages that match it come along.
  const query = messages
    .filter((m) => m.role !== "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n")
    .slice(0, 8000);
  return appendSendersBrand(messages, await buildBrandContext(workspaceId, query ? { query } : {}).catch(() => ""));
}

/** The pure half of withSendersBrand, so the placement rule is tested directly. */
export function appendSendersBrand<M extends { role: string; content: unknown }>(messages: M[], brand: string): M[] {
  if (!brand) return messages;
  const i = messages.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (i === -1) return [{ role: "system", content: brand } as unknown as M, ...messages];
  const out = messages.slice();
  out[i] = { ...out[i], content: `${out[i].content as string}\n\n${brand}` };
  return out;
}

/**
 * The knowledge base's part of the block (owner ask 2026-10-05): the
 * workspace's overview, plus, when the caller says what it is writing about,
 * the passages from its documents that match. "" when there is neither.
 */
async function knowledgeBlock(workspaceId: number, summary: string | null | undefined, query: string | undefined): Promise<string> {
  const found = query ? await searchKnowledge(workspaceId, query, 3) : [];
  return formatKnowledge(summary, found, 6000);
}

export async function buildBrandContext(workspaceId: number, opts: { query?: string } = {}): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  const [[ws], [s], [voice]] = await Promise.all([
    db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
    db.select().from(brandVoiceProfiles).where(eq(brandVoiceProfiles.workspaceId, workspaceId)),
  ]);

  // Product knowledge is facts, not voice: it is not behind applyToAI, and
  // each document has its own on/off in Settings → Knowledge base.
  const knowledge = await knowledgeBlock(workspaceId, (s as { knowledgeSummary?: string | null } | undefined)?.knowledgeSummary, opts.query).catch(() => "");

  // Master gate: an explicit applyToAI=false opts the workspace out of the
  // brand voice and company block.
  if (voice && voice.applyToAI === false) return knowledge;

  const name = (ws?.name ?? "").trim();
  const description = (s?.companyDescription ?? "").trim();
  const valueProp = (s?.valueProposition ?? "").trim();
  const industry = (s?.companyIndustry ?? "").trim();
  const website = (s?.companyWebsite ?? "").trim();
  const keywords = asList(s?.companyKeywords);
  const topics = asList(s?.companyTopics);

  const companyLines: string[] = [];
  if (name) companyLines.push(`- Company: ${name}`);
  if (industry) companyLines.push(`- Industry: ${industry}`);
  if (description) companyLines.push(`- What we do: ${description}`);
  if (valueProp) companyLines.push(`- Value proposition: ${valueProp}`);
  if (website) companyLines.push(`- Website: ${website}`);
  if (topics.length) companyLines.push(`- Themes to emphasise: ${topics.join(", ")}`);
  if (keywords.length) companyLines.push(`- Descriptive keywords: ${keywords.join(", ")}`);

  const vocab = asList(voice?.vocabulary);
  const avoid = asList(voice?.avoidWords);
  const tone = (voice?.tone ?? "").trim();
  const voiceLines: string[] = [];
  if (tone) voiceLines.push(`- Tone: ${tone}`);
  if (vocab.length) voiceLines.push(`- Prefer these words/phrases where natural: ${vocab.join(", ")}`);
  if (avoid.length) voiceLines.push(`- Never use these words/phrases: ${avoid.join(", ")}`);

  if (companyLines.length === 0 && voiceLines.length === 0) return knowledge;

  const parts: string[] = [];
  if (companyLines.length) {
    parts.push(
      `## About the sender (the company you are writing on behalf of)\n` +
        `Ground the value proposition in these facts — never invent claims about the sender.\n` +
        companyLines.join("\n"),
    );
  }
  if (voiceLines.length) {
    parts.push(`## Brand voice (apply to all copy)\n${voiceLines.join("\n")}`);
  }
  if (knowledge) parts.push(knowledge);
  return parts.join("\n\n");
}
