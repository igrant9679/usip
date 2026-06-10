/**
 * EmailClientPreview — "see it like the prospect will" dialog for sequences.
 *
 * Renders a sequence's email steps inside faithful, CSS-only Gmail and
 * Outlook chrome so users can sanity-check subject lines, merge fields and
 * formatting from the recipient's point of view before activating.
 *
 * - Merge fields ({{firstName}}, {{company}}, {{firstName|Friend}}, …) are
 *   resolved with the SAME semantics as server/mergeVars.ts: known-but-empty
 *   vars fall back, unknown tokens are left as-is so reviewers can spot them.
 * - The sample prospect is editable ("Preview as…") so any persona can be
 *   tried without touching real records. Sender = the logged-in user.
 * - Bodies pass through sanitizeEmailHtml (same XSS guard as Mailbox /
 *   EmailDrafts) — never raw dangerouslySetInnerHTML on template HTML.
 * - The email canvas is deliberately light in both clients even when the
 *   app is in dark mode: that's what the prospect actually sees.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Archive, ChevronDown, Forward, MoreVertical, Printer, Reply, ReplyAll,
  Star, Trash2, UserRound,
} from "lucide-react";

/* ─── Sample persona (editable in the dialog) ─────────────────────────── */
export interface PreviewPersona {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  email: string;
}

const DEFAULT_PERSONA: PreviewPersona = {
  firstName: "Jordan",
  lastName: "Smith",
  title: "VP of Operations",
  company: "Acme Corp",
  email: "jordan.smith@acmecorp.com",
};

/* ─── Client-side mirror of server/mergeVars.ts resolveMergeVars ──────── */
function buildVarMap(p: PreviewPersona, sender: { name: string; email: string }): Map<string, string> {
  const m = new Map<string, string>();
  m.set("firstName", p.firstName);
  m.set("lastName", p.lastName);
  m.set("fullName", [p.firstName, p.lastName].filter(Boolean).join(" "));
  m.set("title", p.title);
  m.set("email", p.email);
  m.set("phone", "");
  m.set("city", "");
  m.set("seniority", "");
  m.set("linkedinUrl", "");
  m.set("company", p.company);
  m.set("domain", p.email.includes("@") ? p.email.split("@")[1] : "");
  m.set("industry", "");
  m.set("employeeBand", "");
  m.set("revenueBand", "");
  m.set("region", "");
  m.set("senderName", sender.name);
  m.set("senderEmail", sender.email);
  return m;
}

function resolveMergeVarsClient(text: string, p: PreviewPersona, sender: { name: string; email: string }): string {
  const varMap = buildVarMap(p, sender);
  return text.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const [varName, fallback] = inner.split("|").map((s: string) => s.trim());
    if (!varName) return match;
    const resolved = varMap.get(varName);
    if (resolved !== undefined) return resolved || fallback || resolved;
    return match; // unknown token — leave visible, same as the server
  });
}

/* ─── Email-step extraction (with day offsets from wait steps) ────────── */
interface PreviewEmail {
  stepIndex: number;
  emailNumber: number;
  day: number;
  subject: string;
  body: string;
}

function extractEmails(steps: any[]): PreviewEmail[] {
  const out: PreviewEmail[] = [];
  let day = 1;
  let n = 0;
  for (let i = 0; i < (steps?.length ?? 0); i++) {
    const s = steps[i];
    if (s?.type === "wait") day += Number(s.days) || 0;
    if (s?.type === "email") {
      n++;
      out.push({ stepIndex: i, emailNumber: n, day, subject: String(s.subject ?? ""), body: String(s.body ?? "") });
    }
  }
  return out;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/* ─── Gmail chrome ─────────────────────────────────────────────────────── */
function GmailFrame({ subject, bodyHtml, sender, persona }: {
  subject: string; bodyHtml: string; sender: { name: string; email: string }; persona: PreviewPersona;
}) {
  return (
    <div className="rounded-lg border border-[#dadce0] bg-white text-[#202124] overflow-hidden" style={{ fontFamily: "Roboto, Arial, sans-serif" }}>
      {/* Action bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#f1f3f4] text-[#5f6368]">
        <Archive className="size-4" />
        <Trash2 className="size-4" />
        <Printer className="size-4" />
        <div className="ml-auto"><MoreVertical className="size-4" /></div>
      </div>
      {/* Subject */}
      <div className="px-5 pt-4 pb-1 flex items-start gap-2">
        <h2 className="text-[20px] leading-7 font-normal flex-1 min-w-0 break-words">{subject || "(no subject)"}</h2>
        <span className="text-[11px] px-2 py-0.5 rounded bg-[#f1f3f4] text-[#5f6368] shrink-0 mt-1">Inbox</span>
      </div>
      {/* Sender row */}
      <div className="px-5 py-3 flex items-start gap-3">
        <div className="size-10 rounded-full bg-[#7b1fa2] text-white flex items-center justify-center text-sm font-medium shrink-0">
          {initials(sender.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-bold">{sender.name}</span>
            <span className="text-xs text-[#5f6368] truncate">&lt;{sender.email}&gt;</span>
            <span className="ml-auto text-xs text-[#5f6368] shrink-0 flex items-center gap-2">
              9:14 AM
              <Star className="size-4" />
              <Reply className="size-4" />
              <MoreVertical className="size-4" />
            </span>
          </div>
          <div className="text-xs text-[#5f6368] flex items-center gap-0.5">
            to {persona.firstName ? persona.firstName : "me"} <ChevronDown className="size-3" />
          </div>
        </div>
      </div>
      {/* Body — fixed-width table templates (the email-HTML norm) are
          constrained to the frame so nothing clips; long words still wrap. */}
      <div
        className="px-5 pb-4 text-sm leading-6 [&_a]:text-[#1a73e8] [&_a]:underline [&_p]:my-2 break-words [&_table]:max-w-full [&_td]:break-words [&_img]:max-w-full [&_img]:h-auto"
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
      {/* Reply / Forward pills */}
      <div className="px-5 pb-5 flex gap-2">
        <button type="button" className="flex items-center gap-1.5 text-sm text-[#3c4043] border border-[#dadce0] rounded-full px-4 py-1.5 hover:bg-[#f1f3f4]">
          <Reply className="size-4" /> Reply
        </button>
        <button type="button" className="flex items-center gap-1.5 text-sm text-[#3c4043] border border-[#dadce0] rounded-full px-4 py-1.5 hover:bg-[#f1f3f4]">
          <Forward className="size-4" /> Forward
        </button>
      </div>
    </div>
  );
}

/* ─── Outlook chrome ───────────────────────────────────────────────────── */
function OutlookFrame({ subject, bodyHtml, sender, persona }: {
  subject: string; bodyHtml: string; sender: { name: string; email: string }; persona: PreviewPersona;
}) {
  return (
    <div className="rounded-lg border border-[#e1dfdd] bg-white text-[#242424] overflow-hidden" style={{ fontFamily: '"Segoe UI", system-ui, sans-serif' }}>
      {/* Subject */}
      <div className="px-5 pt-4 pb-2 border-b border-[#f3f2f1]">
        <h2 className="text-[18px] leading-6 font-semibold break-words">{subject || "(no subject)"}</h2>
      </div>
      {/* Sender block + toolbar */}
      <div className="px-5 py-3 flex items-start gap-3">
        <div className="size-10 rounded-full bg-[#0f6cbd] text-white flex items-center justify-center text-sm font-semibold shrink-0">
          {initials(sender.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{sender.name} <span className="font-normal text-[#616161]">&lt;{sender.email}&gt;</span></div>
          <div className="text-xs text-[#616161] truncate">
            To: {persona.firstName || persona.lastName ? `${persona.firstName} ${persona.lastName}`.trim() : "You"}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-3 text-[#0f6cbd] text-xs font-medium mt-1">
          <span className="flex items-center gap-1"><Reply className="size-3.5" /> Reply</span>
          <span className="hidden sm:flex items-center gap-1"><ReplyAll className="size-3.5" /> Reply all</span>
          <span className="flex items-center gap-1"><Forward className="size-3.5" /> Forward</span>
        </div>
      </div>
      <div className="px-5 pb-1 text-xs text-[#616161]">Tue 6/9/2026 9:14 AM</div>
      {/* Body — same table/img constraints as the Gmail frame */}
      <div
        className="px-5 py-4 text-[15px] leading-[1.5] [&_a]:text-[#0f6cbd] [&_a]:underline [&_p]:my-2 break-words [&_table]:max-w-full [&_td]:break-words [&_img]:max-w-full [&_img]:h-auto"
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </div>
  );
}

/* ─── Main dialog ──────────────────────────────────────────────────────── */
export function EmailClientPreview({ open, onClose, steps, sequenceName }: {
  open: boolean;
  onClose: () => void;
  steps: any[];
  sequenceName?: string;
}) {
  const { user } = useAuth();
  const sender = {
    name: (user as any)?.name || "Your Name",
    email: (user as any)?.email || "you@yourcompany.com",
  };

  const [client, setClient] = useState<"gmail" | "outlook">("gmail");
  const [emailIdx, setEmailIdx] = useState(0);
  const [persona, setPersona] = useState<PreviewPersona>(DEFAULT_PERSONA);
  const [personaOpen, setPersonaOpen] = useState(false);

  const emails = useMemo(() => extractEmails(steps), [steps]);
  const current = emails[Math.min(emailIdx, Math.max(0, emails.length - 1))];

  const rendered = useMemo(() => {
    if (!current) return { subject: "", bodyHtml: "" };
    const subject = resolveMergeVarsClient(current.subject, persona, sender);
    const bodyHtml = sanitizeEmailHtml(resolveMergeVarsClient(current.body, persona, sender));
    return { subject, bodyHtml };
    // sender derives from user; safe to key on its fields
  }, [current, persona, sender.name, sender.email]);

  const setP = (patch: Partial<PreviewPersona>) => setPersona((prev) => ({ ...prev, ...patch }));

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* sm:max-w-3xl (not bare max-w-3xl): DialogContent's default ends with
          sm:max-w-lg, which would win at ≥640px and shrink the dialog enough
          to clip 600px-wide table-based email templates. */}
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[92vh] flex flex-col">
        <DialogHeader className="pr-10">
          <DialogTitle className="text-base">
            Prospect preview{sequenceName ? ` — ${sequenceName}` : ""}
          </DialogTitle>
        </DialogHeader>

        {emails.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">
            This sequence has no email steps to preview.
          </div>
        ) : (
          <>
            {/* Controls row: client toggle + step picker */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <div className="inline-flex rounded-md border overflow-hidden">
                {(["gmail", "outlook"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setClient(c)}
                    className={`px-3 py-1.5 text-xs font-medium capitalize ${client === c ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
                  >
                    {c === "gmail" ? "Gmail" : "Outlook"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {emails.map((e, i) => (
                  <button
                    key={e.stepIndex}
                    type="button"
                    onClick={() => setEmailIdx(i)}
                    className={`px-2.5 py-1 rounded-md text-xs border ${i === emailIdx ? "border-primary text-primary font-medium bg-primary/5" : "border-border text-muted-foreground hover:bg-muted"}`}
                    title={`Step ${e.stepIndex + 1}`}
                  >
                    Email {e.emailNumber} · Day {e.day}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-xs gap-1.5"
                onClick={() => setPersonaOpen((v) => !v)}
              >
                <UserRound className="size-3.5" />
                Preview as: {persona.firstName} {persona.lastName} @ {persona.company}
                <ChevronDown className={`size-3.5 transition-transform ${personaOpen ? "rotate-180" : ""}`} />
              </Button>
            </div>

            {/* Editable sample persona */}
            {personaOpen && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 border rounded-md p-3 bg-muted/40 shrink-0">
                {([
                  ["First name", "firstName"],
                  ["Last name", "lastName"],
                  ["Title", "title"],
                  ["Company", "company"],
                  ["Email", "email"],
                ] as const).map(([label, key]) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{label}</Label>
                    <Input
                      value={persona[key]}
                      onChange={(e) => setP({ [key]: e.target.value })}
                      className="h-7 text-xs"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* The rendered email — always light, like a real inbox */}
            <div className="overflow-y-auto flex-1 rounded-lg bg-[#f6f8fc] dark:bg-[#1f1f1f] p-3 sm:p-5">
              {client === "gmail" ? (
                <GmailFrame subject={rendered.subject} bodyHtml={rendered.bodyHtml} sender={sender} persona={persona} />
              ) : (
                <OutlookFrame subject={rendered.subject} bodyHtml={rendered.bodyHtml} sender={sender} persona={persona} />
              )}
            </div>

            <p className="text-[11px] text-muted-foreground shrink-0">
              Merge fields are filled from the sample prospect above; unresolved {"{{tokens}}"} stay visible so you can spot typos. Sent emails use each recipient's real data.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
