/**
 * emailAssist — the AI assistant behind every rich email editor.
 *
 * ONE procedure serving every composition surface (mailbox compose, CRM
 * send-email, sequence steps, draft review, campaign steps), so the editor
 * component carries its assistant with it wherever it is mounted instead of
 * each screen growing its own slightly-different LLM call.
 *
 * Contract with the editor:
 *  - `text` is the fragment being operated on — the user's selection when one
 *    exists, else the whole body. The reply REPLACES exactly that fragment, so
 *    the model must return only the rewritten content, never commentary.
 *  - `isHtml` says which format BOTH sides speak. The editor is Tiptap, whose
 *    values are HTML fragments; plain-textarea callers pass false. Mixing the
 *    two is how "<p>Hi</p>" ends up visible in a sent email, so the format is
 *    explicit rather than sniffed here.
 *  - {{merge}} tags must survive verbatim — they resolve at send time, and a
 *    "helpful" rewrite that inlines "Hi John" freezes one recipient's name
 *    into a template used for hundreds.
 */
import { z } from "zod";
import { repProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { buildBrandContext } from "../services/brandContext";

/**
 * The fixed verbs the editor offers. `write` composes from the instruction;
 * everything else transforms the given text. `custom` applies a free-form
 * instruction to the text — the difference from `write` is that the text is
 * the subject of the instruction rather than empty.
 */
const ASSIST_ACTIONS = {
  write: "Write the email content the user asks for.",
  improve: "Rewrite this to be clearer and more compelling without changing its meaning or length much.",
  shorten: "Rewrite this in roughly half the words. Keep every commitment and call-to-action.",
  expand: "Expand this with one or two sentences of supporting detail. Do not pad.",
  formal: "Rewrite this in a professional, formal tone.",
  friendly: "Rewrite this in a warm, conversational tone.",
  proofread: "Fix grammar, spelling and punctuation only. Change nothing else.",
  custom: "Apply the user's instruction to this text.",
} as const;

export type AssistAction = keyof typeof ASSIST_ACTIONS;

export const emailAssistRouter = router({
  assist: repProcedure
    .input(
      z.object({
        action: z.enum(Object.keys(ASSIST_ACTIONS) as [AssistAction, ...AssistAction[]]),
        /** Required for write/custom; ignored otherwise. */
        instruction: z.string().max(2000).optional(),
        /** The fragment to operate on (selection or whole body). Empty for `write`. */
        text: z.string().max(30000).default(""),
        /** Both request `text` and response are HTML fragments when true. */
        isHtml: z.boolean().default(true),
        /** Optional context that sharpens the output; never required. */
        subject: z.string().max(500).optional(),
        recipientName: z.string().max(200).optional(),
        recipientCompany: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if ((input.action === "write" || input.action === "custom") && !input.instruction?.trim()) {
        return { text: input.text, error: "Tell the assistant what to do first." };
      }

      // Brand voice is additive context — a workspace without one gets the
      // generic assistant, not an error.
      let brandBlock = "";
      try {
        brandBlock = await buildBrandContext(ctx.workspace.id);
      } catch {
        /* brand context is optional */
      }

      const format = input.isHtml
        ? `FORMAT: the text is an HTML fragment and your reply must be one too. Use only these tags: p, br, strong, em, u, s, a, ul, ol, li, h1, h2, h3, blockquote. No <html>, <head> or <body> wrapper, no style/script/class attributes, no markdown.`
        : `FORMAT: plain text only. No HTML, no markdown syntax.`;

      const contextLines = [
        input.subject ? `Email subject: ${input.subject}` : "",
        input.recipientName ? `Recipient: ${input.recipientName}` : "",
        input.recipientCompany ? `Recipient company: ${input.recipientCompany}` : "",
      ].filter(Boolean).join("\n");

      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert B2B sales email assistant embedded in an email editor.
${ASSIST_ACTIONS[input.action]}

Rules:
- Return ONLY the resulting email content — it replaces the user's selection verbatim. No preamble, no explanation, no quotes around it.
- Preserve every {{mergeTag}} EXACTLY as written. Never invent new merge tags.
- Keep the user's language (write in the language of the input).
- ${format}
${brandBlock ? `\nBrand voice:\n${brandBlock}` : ""}`,
          },
          {
            role: "user",
            content:
              (contextLines ? `${contextLines}\n\n` : "") +
              (input.instruction?.trim() ? `Instruction: ${input.instruction.trim()}\n\n` : "") +
              (input.text ? `Text:\n${input.text}` : "(no existing text — compose from the instruction)"),
          },
        ],
        // outputSchema forces valid JSON on Anthropic — freeform prose replies
        // were the empty-fallback failure mode this codebase has hit before.
        outputSchema: {
          name: "email_assist_result",
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        max_tokens: 2000,
        workspaceId: ctx.workspace.id,
      });

      const raw = (res as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
      let text = "";
      try {
        const cleaned = raw.replace(/^```[\w]*\n?|\n?```$/g, "").trim();
        const obj = JSON.parse(cleaned) as { text?: string };
        text = typeof obj.text === "string" ? obj.text : "";
      } catch {
        // A non-JSON reply is still usually the rewritten text itself.
        text = raw.trim();
      }
      if (!text.trim()) {
        return { text: input.text, error: "The assistant returned nothing — try again." };
      }
      return { text, error: null as string | null };
    }),
});
