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
 * The brand_voice_profiles.applyToAI flag (default true) is the master gate:
 * when a workspace turns it OFF, this returns "" and no branding is injected.
 * Returns "" (never throws) whenever there's nothing useful to add, so callers
 * can inject unconditionally: `system += brand ? \`\n\n${brand}\` : ""`.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { workspaces, workspaceSettings, brandVoiceProfiles } from "../../drizzle/schema";

const asList = (v: unknown, max = 20): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : [];

export async function buildBrandContext(workspaceId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";

  const [[ws], [s], [voice]] = await Promise.all([
    db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
    db.select().from(brandVoiceProfiles).where(eq(brandVoiceProfiles.workspaceId, workspaceId)),
  ]);

  // Master gate: an explicit applyToAI=false opts the whole workspace out.
  if (voice && voice.applyToAI === false) return "";

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

  if (companyLines.length === 0 && voiceLines.length === 0) return "";

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
  return parts.join("\n\n");
}
