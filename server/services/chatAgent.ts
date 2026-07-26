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
  return {
    reply: clean(o.reply, MAX_REPLY) ?? fallbackReply,
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
  };
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

  const prompt = `You are ${input.displayName}, an inbound sales assistant chatting with a visitor on our website. Your goal is to understand what they need and, if they are a good fit, get a sales meeting booked.

${brand ? `About us:\n${brand}\n` : ""}${input.persona ? `Additional instructions:\n${input.persona}\n` : ""}
${questions.length ? `Work these into the conversation naturally, one at a time — never interrogate:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n` : ""}
Already known about this visitor (do NOT ask again): ${knownLines.length ? knownLines.join(", ") : "nothing yet"}

Conversation so far:
${transcriptText(input.messages, input.displayName)}

Rules:
- Reply in 1-3 short sentences. Conversational, never a wall of text.
- Ask at most ONE question per reply.
- You need their work email before anything useful can happen — ask for it early, but only once per conversation.
- ${input.canBook
      ? "If they are a good fit and you have their email, say you can find a time and set wantsMeeting to true. Do NOT invent specific times — the system will show real availability."
      : "Do not offer to book a time yourself; say a member of the team will follow up."}
- NEVER invent a name, email, company or phone number. Only extract what the visitor actually said. Use null when they have not said it.
- score = 0-100 fit for a B2B sales conversation, judged on the buying intent and context they have shown. Start low; raise it only on real evidence.

Return JSON:
{
  "reply": "<your next message to the visitor>",
  "extracted": { "name": <string|null>, "email": <string|null>, "company": <string|null>, "phone": <string|null> },
  "score": <integer 0-100>,
  "intent": "<short phrase: what they want>",
  "summary": "<one sentence a rep could read before the call>",
  "wantsMeeting": <true|false>
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
