/**
 * What the AI writers read (owner ask 2026-11-14: "How does the Research
 * section inform the rest of the app and AI generated communications?").
 *
 * Two cards over one read, research.writers.view, which calls the composer
 * every writer calls (server/services/research/context). So these screens
 * show the text a writer is really given, not a description of it.
 *
 *   SectorWritersView   on a sector page: this sector's block, per kind of
 *                       writing, and a plain reason when writers skip it.
 *   RecipientCheck      on the Research home: type an address, or a job
 *                       title and industry, and see which research applies
 *                       and why.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search } from "lucide-react";
import { Section } from "@/components/usip/research/ResearchFields";

export type WriterSurface = "outreach" | "reply" | "research" | "voice" | "judge";

/** The kinds of writing, in the words of the pages that do them. */
export const WRITER_SURFACES: { value: WriterSurface; label: string; where: string }[] = [
  { value: "outreach", label: "Outreach", where: "Campaign and sequence emails, LinkedIn messages, meeting invites, Email Builder" },
  { value: "reply", label: "Replies", where: "Mailbox replies and forwards, suggested replies, chat follow-ups" },
  { value: "research", label: "Briefs and proposals", where: "Prospect dossiers, fit scores, account briefs, deal intelligence, proposals" },
  { value: "voice", label: "Phone calls", where: "The AI voice agent, on calls it places and calls it answers" },
  { value: "judge", label: "Copy check", where: "The check that holds campaign copy which breaks a never-say rule" },
];

export const MATCH_REASON: Record<string, string> = {
  sector: "This sector was chosen directly.",
  campaign: "They are in a Revenue Engine campaign that uses this research.",
  account: "Their company is tagged with this sector.",
  persona: "The persona was chosen, and it belongs to this sector.",
  title: "Their job title matches.",
  industry: "Their industry matches.",
};

const SECTOR_NOT_USED: Record<string, string> = {
  draft: "This sector is a draft, so no writer reads it yet. Set its status to Researched or Verified when it is ready.",
  paused: "This sector came from a Downstream link that is paused, so writers skip it until the link is resumed.",
  missing: "This sector is not in this workspace.",
};

function SurfacePicker({ value, onChange, id }: { value: WriterSurface; onChange: (v: WriterSurface) => void; id: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Kind of writing</Label>
      <Select value={value} onValueChange={(v) => onChange(v as WriterSurface)}>
        <SelectTrigger id={id} className="w-full sm:w-64"><SelectValue /></SelectTrigger>
        <SelectContent>
          {WRITER_SURFACES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{WRITER_SURFACES.find((s) => s.value === value)?.where}</p>
    </div>
  );
}

function Block({ text, chars, budget }: { text: string; chars: number; budget: number }) {
  return (
    <div className="space-y-1">
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">{text}</pre>
      <p className="text-[11px] text-muted-foreground">
        {chars.toLocaleString()} of {budget.toLocaleString()} characters for this kind of writing. When research runs over, the least
        important parts are left out first; a never-say rule is never left out.
      </p>
    </div>
  );
}

/** On a sector page: exactly what a writer is handed from this sector. */
export function SectorWritersView({ sectorId, dirty }: { sectorId: number; dirty?: boolean }) {
  const [surface, setSurface] = useState<WriterSurface>("outreach");
  const q = trpc.research.writers.view.useQuery({ surface, sectorId });
  const d = q.data;
  return (
    <Section
      id="writers-view"
      title="What the AI writers read"
      description="The exact text a writer is given from this sector. A persona's notes are added when the recipient's job title matches one."
    >
      <SurfacePicker id="writers-view-surface" value={surface} onChange={setSurface} />
      {dirty && <p className="text-xs text-muted-foreground">This shows the saved version. Save your changes to see them here.</p>}
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading</p>
      ) : q.error ? (
        <p className="text-xs text-destructive">Could not load what the writers read: {q.error.message}</p>
      ) : d?.sectorNotUsed ? (
        <p className="text-sm">{SECTOR_NOT_USED[d.sectorNotUsed]}</p>
      ) : d && d.block ? (
        <Block text={d.block} chars={d.chars} budget={d.budget} />
      ) : (
        <p className="text-sm">
          Nothing in this sector is used for this kind of writing yet. Add pain points, vocabulary, lead-with points or never-say rules above.
        </p>
      )}
    </Section>
  );
}

/** On the Research home: which research applies to one recipient, and why. */
export function RecipientCheck() {
  const [surface, setSurface] = useState<WriterSurface>("outreach");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [industry, setIndustry] = useState("");
  const [asked, setAsked] = useState<{ surface: WriterSurface; email?: string; title?: string; industry?: string } | null>(null);
  const q = trpc.research.writers.view.useQuery(asked ?? { surface }, { enabled: asked != null });
  const d = asked ? q.data : undefined;
  const canAsk = !!(email.trim() || title.trim() || industry.trim());
  const ask = () => {
    if (!canAsk) return;
    setAsked({ surface, email: email.trim() || undefined, title: title.trim() || undefined, industry: industry.trim() || undefined });
  };
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") ask(); };

  return (
    <Section
      id="recipient-check"
      title="Check what a writer would use"
      description="Type someone's email address, or a job title and industry, to see which research the AI writers would use for them and why."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="rc-email">Email address</Label>
          <Input id="rc-email" type="email" value={email} maxLength={320} placeholder="someone@company.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={onEnter} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rc-title">Job title</Label>
          <Input id="rc-title" value={title} maxLength={160} placeholder="e.g. Operations Director" onChange={(e) => setTitle(e.target.value)} onKeyDown={onEnter} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rc-industry">Industry</Label>
          <Input id="rc-industry" value={industry} maxLength={160} placeholder="e.g. Hospitals" onChange={(e) => setIndustry(e.target.value)} onKeyDown={onEnter} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SurfacePicker id="rc-surface" value={surface} onChange={setSurface} />
        <Button onClick={ask} disabled={!canAsk || q.isFetching} className="mb-6">
          {q.isFetching ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Search className="size-4 mr-1" />} Check
        </Button>
      </div>

      {asked && q.error && <p className="text-xs text-destructive">Could not check: {q.error.message}</p>}
      {d && (
        <div className="space-y-3 border-t pt-4" aria-live="polite">
          {d.recordFound === false && (
            <p className="text-sm">That address is not on a person, contact, lead or campaign prospect in this workspace{asked?.title || asked?.industry ? ", so only the title and industry you typed were used." : "."}</p>
          )}
          {d.recordFound && (
            <p className="text-xs text-muted-foreground">
              On record: {d.known.title || "no job title"}{d.known.industry ? `, ${d.known.industry}` : ", no industry"}
              {d.known.inCampaign ? "; in a Revenue Engine campaign" : ""}{d.known.companyHasSector ? "; company tagged with a sector" : ""}.
            </p>
          )}
          {d.sector || d.persona ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {d.sector && <Badge variant="secondary">{d.sector.marketName ? `${d.sector.marketName} › ` : ""}{d.sector.name}</Badge>}
                {d.persona && <Badge variant="outline">Persona: {d.persona.name}</Badge>}
                <span className="text-muted-foreground">{d.matchedBy ? MATCH_REASON[d.matchedBy] : ""}</span>
              </div>
              {d.block
                ? <Block text={d.block} chars={d.chars} budget={d.budget} />
                : <p className="text-sm">That research has nothing for this kind of writing yet.</p>}
            </>
          ) : (
            <p className="text-sm">
              No research matches, so a writer would write for them as it did before Research existed. A sector is used when it is
              Researched or Verified and its targeting titles or industries match, or when a campaign or the company names it.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
