/**
 * Inbound Chat Agent — the AI behind the public /c/:slug chat widget.
 *
 * One visitor turn does four things at once, in a single LLM call:
 *   1. replies in the workspace's brand voice,
 *   2. extracts whatever identity it just learned (name/email/company/phone),
 *   3. scores the visitor against the workspace ICP,
 *   4. says whether it's time to offer a meeting.
 *
 * Doing all four in one call is deliberate: a separate extraction pass would
 * double the per-message cost and latency of a surface a stranger is waiting on.
 *
 * Everything the model returns is treated as untrusted: `mergeVisitor` and
 * `sanitizeTurn` below are pure and fully tested, so a hallucinated email or a
 * 10k-character "reply" can never reach the database or the visitor.
 *
 * The decision of what to DO with a qualified visitor is NOT the model's — it
 * is `decideOffer`, a pure function of the agent's Off/Approve/Auto mode. The
 * model can want to book all it likes; an agent in `approval` mode will still
 * only hand the visitor to a human.
 */
import { invokeLLM } from "../_core/llm";
import { buildBrandContext } from "./brandContext";

export type ChatMode = "off" | "approval" | "auto";
export type ChatRole = "visitor" | "agent";
export interface ChatMessage {
  role: ChatRole;
  text: string;
  at: string;
}

/** What we know about the person on the other end. */
export interface VisitorFacts {
  name: string | null;
  email: string | null;
  company: string | null;
  phone: string | null;
}

/** The model's structured view of one turn, after sanitization. */
export interface ChatTurn {
  reply: string;
  extracted: VisitorFacts;
  score: number;
  intent: string | null;
  summary: string | null;
  /** The model's opinion that it's time to talk times. Advisory only. */
  wantsMeeting: boolean;
  /**
   * The model saying it cannot help — the SECOND handoff trigger (0139). The
   * first, an explicit request for a person, is detected deterministically by
   * `wantsHuman` and never depends on this.
   */
  needsHuman: boolean;
}

/** What the server should actually do next, given the agent's autonomy mode. */
export type OfferAction =
  /** Show real calendar slots and let the visitor book unattended. */
  | "book"
  /** Qualified, but a human owns the booking — notify the rep instead. */
  | "handoff"
  /** Keep talking. */
  | "none";

const MAX_REPLY = 1200;
const MAX_TURNS_IN_PROMPT = 20;

/* ────────────────────────────── pure helpers ─────────────────────────────── */

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "unknown") return null;
  return t.slice(0, max);
}

/**
 * Accept an email only if it is structurally plausible. The model will happily
 * invent `john@example.com` when the visitor never gave one, and that address
 * would become a real lead and a real calendar invite to a stranger.
 */
export function plausibleEmail(v: unknown): string | null {
  const t = clean(v, 320);
  if (!t) return null;
  if (!/^[^\s@]+@[^\s@,]+\.[a-z]{2,}$/i.test(t)) return null;
  if (/^(john|jane)?\.?(doe|smith)@|@(example|test|domain|email|yourcompany|company)\./i.test(t)) return null;
  return t.toLowerCase();
}

/**
 * Fold newly-extracted facts into what we already knew.
 *
 * Existing values WIN. Once a visitor has told us their email, a later turn
 * where the model re-guesses it must not overwrite it — that is exactly how a
 * lead ends up with the wrong address halfway through a conversation.
 */
export function mergeVisitor(existing: Partial<VisitorFacts>, extracted: Partial<VisitorFacts>): VisitorFacts {
  const pick = (cur: string | null | undefined, next: string | null | undefined) => {
    const c = clean(cur, 320);
    return c ?? clean(next, 320) ?? null;
  };
  return {
    name: pick(existing.name, extracted.name)?.slice(0, 200) ?? null,
    email: plausibleEmail(existing.email) ?? plausibleEmail(extracted.email),
    company: pick(existing.company, extracted.company)?.slice(0, 200) ?? null,
    phone: pick(existing.phone, extracted.phone)?.slice(0, 40) ?? null,
  };
}

/**
 * A visitor who is explicitly asking for a meeting gets one at a lower bar than
 * one the agent merely likes the look of — but not at any bar. Below this,
 * `wantsMeeting` is treated as model enthusiasm, not visitor intent.
 */
export const MEETING_REQUEST_FLOOR = 40;

/**
 * What to do with this visitor right now.
 *
 * An email is a hard prerequisite for BOTH outcomes: without one there is no
 * one to send the invite to and no lead worth routing, so the agent keeps
 * talking instead. `alreadyBooked` makes repeat turns idempotent — a booked
 * session never re-offers slots.
 */
export function decideOffer(opts: {
  mode: ChatMode;
  score: number;
  threshold: number;
  hasEmail: boolean;
  wantsMeeting: boolean;
  alreadyBooked: boolean;
}): OfferAction {
  if (opts.mode === "off" || opts.alreadyBooked || !opts.hasEmail) return "none";
  const qualified = opts.score >= opts.threshold;
  const asked = opts.wantsMeeting && opts.score >= MEETING_REQUEST_FLOOR;
  if (!qualified && !asked) return "none";
  // Mode — not the model — decides whether a human is in the loop.
  return opts.mode === "auto" ? "book" : "handoff";
}

/** Clamp a raw model response into something safe to persist and display. */
export function sanitizeTurn(raw: unknown, fallbackReply: string): ChatTurn {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ex = (o.extracted && typeof o.extracted === "object" ? o.extracted : {}) as Record<string, unknown>;
  const scoreNum = Math.round(Number(o.score));
  // Claims are scrubbed HERE so every path through the agent is covered, not
  // just the happy one. If scrubbing empties the reply the model said nothing
  // we can stand behind, so we say something honest instead of nothing.
  const scrubbed = scrubUnsupportedClaims(clean(o.reply, MAX_REPLY) ?? fallbackReply);
  if (scrubbed.removed.length) {
    console.warn(
      "[chatAgent] dropped unsupported claim(s):",
      scrubbed.removed.map((r) => `${r.kind}: ${r.sentence}`).join(" | "),
    );
  }
  return {
    reply: scrubbed.text || CLAIM_FALLBACK,
    extracted: {
      name: clean(ex.name, 200),
      email: plausibleEmail(ex.email),
      company: clean(ex.company, 200),
      phone: clean(ex.phone, 40),
    },
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, scoreNum)) : 0,
    intent: clean(o.intent, 240),
    summary: clean(o.summary, 1000),
    wantsMeeting: o.wantsMeeting === true,
    needsHuman: o.needsHuman === true,
  };
}

/**
 * Sentences that make a claim we cannot stand behind.
 *
 * Prompt rules are a hope; this is a mechanism. Measured on the live agent AFTER
 * the rule was added to the prompt, it still produced "we've helped nonprofits
 * automate report compilation and data mapping to save weeks each quarter" —
 * an unnamed client claim AND a quantified savings figure in one sentence, both
 * explicitly forbidden by its own persona.
 *
 * Two families, deliberately narrow so ordinary capability talk survives:
 *   - TRACK RECORD: past-tense/possessive experience ("we've helped", "our
 *     clients"). Present-tense capability ("we help nonprofits automate X") is
 *     what the agent is FOR and is left alone.
 *   - QUANTIFIED OUTCOME: a saving attached to a number or a time unit
 *     ("save 30%", "save weeks each quarter"). Unquantified benefit
 *     ("free up time") is fine.
 *
 * Offending sentences are dropped rather than rewritten — a reply missing a
 * sentence is recoverable; a reply inventing a track record is not.
 */
const CLAIM_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "track_record",
    re: /\b(?:we(?:'ve|’ve| have)\s+(?:helped|worked\s+with|done\s+this\s+for|served|delivered)|our\s+(?:clients|customers)\b|we\s+work\s+with\s+[^.!?]*\b(?:regularly|often|all\s+the\s+time|every\s+day)\b)/i,
  },
  {
    kind: "quantified_outcome",
    re: /\b(?:sav(?:e|es|ed|ing)|reduc(?:e|es|ed)|cut(?:s|ting)?|free(?:s|d)?\s+up)\b[^.!?]{0,60}?(?:\d+\s*%|\d+\s*(?:hours?|days?|weeks?|months?|hrs?)|\b(?:hours|days|weeks|months)\b)/i,
  },
  { kind: "price", re: /(?:[$£€]\s?\d|\b\d+\s?(?:k|thousand)\b[^.!?]{0,30}\b(?:cost|price|fee|budget)\b)/i },
];

export interface ClaimScrubResult {
  text: string;
  removed: Array<{ kind: string; sentence: string }>;
}

/**
 * Drop sentences making unsupported claims. Pure. Returns the cleaned text plus
 * what was removed, so the caller can log WHY a reply got shorter — a silent
 * scrub would be indistinguishable from the model simply being terse.
 */
export function scrubUnsupportedClaims(reply: string): ClaimScrubResult {
  const text = String(reply ?? "");
  if (!text.trim()) return { text, removed: [] };
  // Keep the delimiter with its sentence so rejoining preserves punctuation.
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const removed: ClaimScrubResult["removed"] = [];
  const kept = sentences.filter((s) => {
    const hit = CLAIM_PATTERNS.find((p) => p.re.test(s));
    if (hit) {
      removed.push({ kind: hit.kind, sentence: s.trim() });
      return false;
    }
    return true;
  });
  const out = kept.join("").replace(/\s+/g, " ").trim();
  return { text: out, removed };
}

/** Used when scrubbing removed everything the model said. */
const CLAIM_FALLBACK =
  "I'd rather not guess at that — the honest answer depends on your setup. The best next step is a short audit conversation where we look at your actual process. Would that be useful?";

/**
 * Is the visitor asking to speak to a person?
 *
 * Deterministic on purpose. Escalation is the one thing that must not depend on
 * the model agreeing it is warranted — a visitor who has decided they want a
 * human has already stopped wanting the bot's opinion, and a model that talks
 * itself out of escalating is the exact failure this prevents.
 *
 * Narrow by design. False positives are expensive in the other direction: every
 * one mints a task for a rep and tells a visitor to expect a call. "Human
 * resources", "is someone there?" as an opener, and "a real problem" must all
 * stay negative, so the patterns require a request VERB near a person NOUN.
 */
const HUMAN_NOUN = "(?:human|person|someone|somebody|agent|rep(?:resentative)?|advisor|adviser|consultant|team)";
const HUMAN_PATTERNS: RegExp[] = [
  // "talk/speak/chat to a human", "can I speak with someone"
  new RegExp(`\\b(?:talk|speak|chat|connect|deal)\\s+(?:to|with)\\s+(?:a|an|the|your|some)?\\s*(?:real\\s+|actual\\s+|live\\s+)?${HUMAN_NOUN}\\b`, "i"),
  // "get me a human", "put me through to someone", "connect me to a real person"
  new RegExp(`\\b(?:get|put|pass|transfer|hand|connect|direct|link)\\s+me\\s+(?:on\\s+)?(?:to|through\\s+to|over\\s+to|with)?\\s*(?:a|an|the)?\\s*(?:real\\s+|actual\\s+|live\\s+)?${HUMAN_NOUN}\\b`, "i"),
  // "is there a real person", "are you a bot/robot/AI?"
  new RegExp(`\\b(?:is|are)\\s+(?:there|this|you)\\s+(?:a|an)?\\s*(?:real\\s+)?(?:${HUMAN_NOUN}|bot|robot|ai|chatbot)\\b`, "i"),
  // "I want/need to speak to a human" is covered above; this catches the bare
  // "I'd rather talk to a person" / "just give me a human".
  new RegExp(`\\b(?:rather|just|please)\\s+(?:\\w+\\s+){0,3}${HUMAN_NOUN}\\b`, "i"),
];

export function wantsHuman(text: string): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  // "human resources" is a department, not a request.
  const cleaned = t.replace(/\bhuman\s+resources\b/gi, " ");
  return HUMAN_PATTERNS.some((re) => re.test(cleaned));
}

/**
 * The line appended to a reply when a handoff fires.
 *
 * Measured live: the model's own reply already ended with "I'll just need your
 * work email", and appending the ask again produced a message that asked twice
 * in four lines. The promise is always worth stating; the question is only
 * worth adding when nobody has asked it yet — and only when we actually lack an
 * address, because otherwise the promise is one we cannot keep.
 */
export function handoffLine(opts: { hasEmail: boolean; replyAsksForEmail: boolean }): string {
  return opts.hasEmail || opts.replyAsksForEmail
    ? "I've asked a colleague to pick this up — they'll be in touch shortly."
    : "I've asked a colleague to pick this up. What's the best email for them to reach you on?";
}

/**
 * First plausible email address appearing anywhere in free text.
 *
 * `known` is built from the SESSION row, which is only updated AFTER a turn is
 * generated. So on the exact turn a visitor types their address, the prompt
 * still believed we had none — and told the model it MUST ask. Measured live:
 * "Can I send you a calendar link? (I'll just need your work email to set that
 * up.)" in reply to a message that had just given it.
 */
export function emailInText(text: string): string | null {
  const m = String(text ?? "").match(/[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[a-z]{2,}/i);
  return m ? plausibleEmail(m[0].replace(/[.,;:!?]+$/, "")) : null;
}

/**
 * How many times the agent has already asked this visitor for an email.
 *
 * The prompt has always said "ask only once per conversation" and the model has
 * always ignored it — measured on the live agent, it asked four turns running,
 * including immediately after declining to answer a question. A stateless prompt
 * re-decides every turn, so "only once" has to be COUNTED and fed back in, not
 * requested. Pure so it can be tested without a model.
 */
export function emailAskCount(messages: ChatMessage[]): number {
  return (messages ?? []).filter(
    (m) => m?.role === "agent" && /\be-?mail\b/i.test(m.text ?? "") && (m.text ?? "").includes("?"),
  ).length;
}

/** Render the transcript for the prompt, most recent turns only. */
export function transcriptText(messages: ChatMessage[], displayName: string): string {
  return messages
    .slice(-MAX_TURNS_IN_PROMPT)
    .map((m) => `${m.role === "visitor" ? "Visitor" : displayName}: ${m.text}`)
    .join("\n");
}

/* ──────────────────────────────── the turn ───────────────────────────────── */

export interface ChatTurnInput {
  workspaceId: number;
  displayName: string;
  persona: string | null;
  qualifyingQuestions: string[];
  /** Full transcript INCLUDING the visitor message being answered. */
  messages: ChatMessage[];
  known: Partial<VisitorFacts>;
  /** True when this agent is allowed to actually book, so the model can say so. */
  canBook: boolean;
  /**
   * Facts this agent may answer from (migration 0136), already selected and
   * rendered for this turn. Empty string when the workspace has written none.
   */
  knowledge?: string;
  /**
   * Where the visitor is standing (migration 0138), already rendered by
   * describePageContext. The only situational awareness the agent has at turn
   * zero, and the only thing that stops it pitching on a careers page.
   */
  pageContext?: string;
  /** True once a person has been asked to pick this up (0139). */
  handedOff?: boolean;
}

/**
 * Run one turn. Never throws — a failed LLM call degrades to a polite holding
 * reply rather than a broken widget in front of a stranger.
 */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurn> {
  const fallback =
    "Thanks — could you tell me a little more about what you're looking for, and the best email to reach you on?";

  let brand = "";
  try {
    brand = await buildBrandContext(input.workspaceId);
  } catch {
    /* brand context is a nicety, not a requirement */
  }

  const questions = input.qualifyingQuestions.filter(Boolean).slice(0, 8);
  const knownLines = [
    input.known.name ? `name: ${input.known.name}` : null,
    input.known.email ? `email: ${input.known.email}` : null,
    input.known.company ? `company: ${input.known.company}` : null,
    input.known.phone ? `phone: ${input.known.phone}` : null,
  ].filter(Boolean);

  // An address the visitor typed THIS turn counts as having it — `known` lags
  // by one turn (see emailInText), and without this the agent asks for an email
  // it is currently looking at.
  const lastVisitorText = [...(input.messages ?? [])].reverse()
    .find((m) => m.role === "visitor")?.text ?? "";
  const hasEmail = !!input.known.email || !!emailInText(lastVisitorText);
  // Counted, not requested — see emailAskCount.
  const emailAsks = hasEmail ? 0 : emailAskCount(input.messages);

  /**
   * One instruction, not two. The first version had an "ask for the email"
   * bullet AND an "offer the meeting" bullet; measured live, the model merged
   * them and dropped the email entirely — swinging from asking four times to
   * never asking, which cannot book at all. The ladder below is explicit about
   * what to do on THIS turn.
   */
  const emailGuidance = hasEmail
    ? "You already have their email — never ask for it again."
    : emailAsks === 0
      ? `You cannot book anything without their work email; it is a hard requirement.${input.canBook ? " If they look like a fit, offer the meeting AND ask for their email in the same reply, as the way to confirm it — the ask should buy them something." : ""} Your reply MUST contain that question.`
      : emailAsks === 1
        ? "You have asked for their email once already. Ask again ONLY if they have shown real interest since; otherwise answer what they asked and earn it first."
        : `You have asked for their email ${emailAsks} times and they have not given it. Do NOT ask again — asking repeatedly is the fastest way to get this chat closed. Answer what they actually asked and give them a concrete reason to keep talking.`;

  const prompt = `You are ${input.displayName}, an inbound sales assistant chatting with a visitor on our website. Your goal is to understand what they need and, if they are a good fit, get a sales meeting booked.

${brand ? `About us:\n${brand}\n` : ""}${input.persona ? `Additional instructions:\n${input.persona}\n` : ""}
${input.knowledge ? `Facts you may answer from:\n${input.knowledge}\nThese facts and "About us" above are the ONLY specifics you may state. This applies to WHAT SERVICES WE OFFER as much as to anything else: if a visitor asks whether we do something and it is not written above, you do NOT know — say so, say you will find out, and offer the audit conversation. Confirming a service we have not listed is the single worst thing you can do here, because someone will book expecting it.\n` : ""}${questions.length ? `Work these into the conversation naturally, one at a time — never interrogate:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n` : ""}
${input.pageContext ? `${input.pageContext}\n\n` : ""}Already known about this visitor (do NOT ask again): ${knownLines.length ? knownLines.join(", ") : "nothing yet"}

Conversation so far:
${transcriptText(input.messages, input.displayName)}

Rules:
- Reply in 1-3 short sentences. Conversational, never a wall of text.
- Ask at most ONE question per reply.
- NEVER claim experience, clients, results or a track record that is not stated in "About us" above. This includes UNNAMED claims — "we work with organisations like yours regularly" is exactly as forbidden as naming one. If asked who you have worked with or for a reference, say what you can DO and offer to walk them through the approach; do not imply a client base you have not been given.
- ${emailGuidance}
- ${input.canBook
      ? hasEmail
        ? "If they are a good fit, say you can find a time and set wantsMeeting to true. Do NOT invent specific times — the system will show real availability."
        : "Do NOT invent specific times — the system will show real availability once you have their email."
      : "Do not offer to book a time yourself; say a member of the team will follow up."}
- ${input.handedOff
      ? "A colleague has ALREADY been asked to pick this up. Do not offer to book, and do not repeat the promise — say what you can, briefly, and let them wait for the person."
      : "Set needsHuman true when you genuinely cannot help — a question outside what you were told, a complaint, or anything where guessing would be worse than waiting. Being unable to answer is not a failure; pretending is."}
- NEVER invent a name, email, company or phone number. Only extract what the visitor actually said. Use null when they have not said it.
- score = 0-100 fit for a B2B sales conversation, judged on the buying intent and context they have shown. Start low; raise it only on real evidence.

Return JSON:
{
  "reply": "<your next message to the visitor>",
  "extracted": { "name": <string|null>, "email": <string|null>, "company": <string|null>, "phone": <string|null> },
  "score": <integer 0-100>,
  "intent": "<short phrase: what they want>",
  "summary": "<one sentence a rep could read before the call>",
  "wantsMeeting": <true|false>,
  "needsHuman": <true ONLY if you genuinely cannot help and a person should take over, else false>
}`;

  try {
    const res = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      // outputSchema forces valid JSON for Anthropic (see taskAutopilot note).
      outputSchema: {
        name: "chat_turn",
        schema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            extracted: {
              type: "object",
              properties: {
                name: { type: ["string", "null"] },
                email: { type: ["string", "null"] },
                company: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
              },
            },
            score: { type: "integer" },
            intent: { type: "string" },
            summary: { type: "string" },
            wantsMeeting: { type: "boolean" },
            needsHuman: { type: "boolean" },
          },
          required: ["reply", "score", "wantsMeeting"],
        },
      },
      max_tokens: 600,
      workspaceId: input.workspaceId,
    });
    // content is typed as string | ContentBlock[]; the json path always yields
    // a string, and anything else is a provider surprise we treat as empty.
    const content = res.choices?.[0]?.message?.content;
    return sanitizeTurn(JSON.parse(typeof content === "string" && content ? content : "{}"), fallback);
  } catch (e) {
    console.error("[chatAgent] turn failed:", (e as Error).message);
    return sanitizeTurn({}, fallback);
  }
}
