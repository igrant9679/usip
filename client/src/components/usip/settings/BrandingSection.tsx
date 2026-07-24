/**
 * BrandingSection — the one-stop per-workspace Branding settings subpage
 * (/v2/settings/branding). Consolidates what was previously scattered or
 * dead-wired into a single place:
 *   - Logo            → workspaces.logoUrl (workspace.updateBranding)
 *   - Brand colours   → workspace_settings.brandPrimary/brandAccent (settings.save)
 *   - Company profile → workspace_settings.company* (settings.save, migration 0125)
 *   - Brand voice     → brand_voice_profiles (brandVoice.save)
 *   - Personas        → link-out to the full /personas editor
 *   - Social accounts → honest "coming soon" placeholder (to be added)
 *
 * The brand colour now actually drives the app (Shell applies brandPrimary as
 * the default palette), the logo now renders (Shell), and the company profile +
 * brand voice now feed AI outreach (buildBrandContext). One header Save fans out
 * to whichever of the three backends changed. All writes are admin-gated
 * server-side; inputs disable + a hint shows for non-admins.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Users, Share2, X, ExternalLink } from "lucide-react";

const TONES = ["professional", "conversational", "direct", "empathetic", "authoritative"] as const;
type Tone = (typeof TONES)[number];
const HEX = /^#([0-9A-Fa-f]{6})$/;

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 sm:p-6 space-y-4 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="text-[12.5px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Chip input: type + Enter/comma to add, click × to remove. */
function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next.slice(0, 50));
    setDraft("");
  };
  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5 rounded-md border px-2 py-1.5 min-h-9",
        disabled ? "border-border/60 bg-muted/50" : "border-border bg-background",
      )}
    >
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[12px] text-foreground">
          {tag}
          {!disabled && (
            <button type="button" onClick={() => onChange(value.filter((x) => x !== tag))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${tag}`}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
          else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ""}
        className="min-w-[120px] flex-1 bg-transparent text-[13px] outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

function ColorField({ label, value, onChange, disabled, hint }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={HEX.test(value) ? value : "#14B89A"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-background disabled:cursor-not-allowed"
          aria-label={label}
        />
        <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder="#14B89A" className="font-mono" />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BrandingSection() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";
  const settings = trpc.settings.get.useQuery();
  const voice = trpc.brandVoice.get.useQuery();
  const branding = trpc.workspace.getBranding.useQuery();

  // form state, seeded once all three loads resolve
  const [logoUrl, setLogoUrl] = useState("");
  const [brandPrimary, setBrandPrimary] = useState("#14B89A");
  const [brandAccent, setBrandAccent] = useState("#0F766E");
  const [description, setDescription] = useState("");
  const [valueProp, setValueProp] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [tone, setTone] = useState<Tone>("professional");
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [avoidWords, setAvoidWords] = useState<string[]>([]);
  const [applyToAI, setApplyToAI] = useState(true);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !settings.data || !branding.data || voice.isLoading) return;
    const s: any = settings.data;
    setLogoUrl(branding.data.logoUrl ?? "");
    setBrandPrimary(s.brandPrimary ?? "#14B89A");
    setBrandAccent(s.brandAccent ?? "#0F766E");
    setDescription(s.companyDescription ?? "");
    setValueProp(s.valueProposition ?? "");
    setIndustry(s.companyIndustry ?? "");
    setWebsite(s.companyWebsite ?? "");
    setKeywords(Array.isArray(s.companyKeywords) ? s.companyKeywords : []);
    setTopics(Array.isArray(s.companyTopics) ? s.companyTopics : []);
    const v: any = voice.data;
    if (v) {
      setTone((TONES.includes(v.tone) ? v.tone : "professional") as Tone);
      setVocabulary(Array.isArray(v.vocabulary) ? v.vocabulary : []);
      setAvoidWords(Array.isArray(v.avoidWords) ? v.avoidWords : []);
      setApplyToAI(v.applyToAI !== false);
    }
    setSeeded(true);
  }, [settings.data, branding.data, voice.data, voice.isLoading, seeded]);

  const saveSettings = trpc.settings.save.useMutation();
  const saveVoice = trpc.brandVoice.save.useMutation();
  const saveLogo = trpc.workspace.updateBranding.useMutation();
  const [saving, setSaving] = useState(false);

  // dirty tracking per backend
  const s: any = settings.data;
  const v: any = voice.data;
  const eqArr = (a: string[], b: any) => JSON.stringify(a) === JSON.stringify(Array.isArray(b) ? b : []);
  const settingsDirty = seeded && !!s && (
    brandPrimary !== (s.brandPrimary ?? "#14B89A") ||
    brandAccent !== (s.brandAccent ?? "#0F766E") ||
    description !== (s.companyDescription ?? "") ||
    valueProp !== (s.valueProposition ?? "") ||
    industry !== (s.companyIndustry ?? "") ||
    website !== (s.companyWebsite ?? "") ||
    !eqArr(keywords, s.companyKeywords) ||
    !eqArr(topics, s.companyTopics)
  );
  const voiceDirty = seeded && (
    tone !== (v?.tone ?? "professional") ||
    !eqArr(vocabulary, v?.vocabulary) ||
    !eqArr(avoidWords, v?.avoidWords) ||
    applyToAI !== (v?.applyToAI !== false)
  );
  const logoDirty = seeded && logoUrl.trim() !== (branding.data?.logoUrl ?? "");
  const dirty = isAdmin && (settingsDirty || voiceDirty || logoDirty);

  const save = async () => {
    if (brandPrimary && !HEX.test(brandPrimary)) { toast.error("Brand colour must be a 6-digit hex like #14B89A"); return; }
    if (brandAccent && !HEX.test(brandAccent)) { toast.error("Accent colour must be a 6-digit hex like #0F766E"); return; }
    const logo = logoUrl.trim();
    if (logo && !/^https?:\/\/.+/i.test(logo)) { toast.error("Logo must be a full https:// image URL"); return; }
    setSaving(true);
    try {
      if (settingsDirty) {
        await saveSettings.mutateAsync({
          brandPrimary,
          brandAccent,
          companyDescription: description.trim() || null,
          valueProposition: valueProp.trim() || null,
          companyIndustry: industry.trim() || null,
          companyWebsite: website.trim() || null,
          companyKeywords: keywords,
          companyTopics: topics,
        } as any);
      }
      if (voiceDirty) {
        await saveVoice.mutateAsync({ tone, vocabulary, avoidWords, applyToAI });
      }
      if (logoDirty) {
        await saveLogo.mutateAsync({ logoUrl: logo || null });
      }
      await Promise.all([
        utils.settings.get.invalidate(),
        utils.brandVoice.get.invalidate(),
        utils.workspace.getBranding.invalidate(),
      ]);
      // re-seed from fresh server state
      setSeeded(false);
      toast.success("Branding saved");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save branding");
    } finally {
      setSaving(false);
    }
  };

  const loading = settings.isLoading || branding.isLoading || voice.isLoading;

  return (
    <>
      <div className="shrink-0 px-6 pt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Branding</h1>
          <p className="text-[12.5px] text-muted-foreground">Your workspace's colours, logo, company profile, and brand voice.</p>
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={save} className="gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto w-full max-w-[820px] px-4 sm:px-6 py-6 space-y-5">
          {!isAdmin && (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
              Only workspace admins can change branding. You can view the current settings below.
            </div>
          )}

          {loading ? (
            <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 rounded-xl bg-card/70 animate-pulse" />)}</div>
          ) : (
            <>
              {/* Logo */}
              <Card title="Logo" description="Shown in the sidebar and workspace switcher. Paste a hosted image URL (PNG/SVG on a transparent background works best).">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-40 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background px-2">
                    {logoUrl.trim() ? (
                      <img src={logoUrl.trim()} alt="Logo preview" className="max-h-10 max-w-full object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                    ) : (
                      <span className="text-[12px] text-muted-foreground">No logo</span>
                    )}
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <Label>Logo URL</Label>
                    <Input value={logoUrl} disabled={!isAdmin} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" />
                  </div>
                </div>
              </Card>

              {/* Brand colours */}
              <Card title="Brand colours" description="The primary colour becomes your workspace's default app accent. Each teammate can still pick a personal palette that overrides it for them.">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <ColorField label="Primary" value={brandPrimary} onChange={setBrandPrimary} disabled={!isAdmin} hint="Buttons, links, active nav." />
                  <ColorField label="Accent" value={brandAccent} onChange={setBrandAccent} disabled={!isAdmin} hint="Secondary brand colour (emails, gradients)." />
                </div>
              </Card>

              {/* Company profile */}
              <Card title="Company profile" description="Who you are and what you offer. This feeds the AI outreach writers so emails describe your company accurately — no invented claims.">
                <div className="space-y-1.5">
                  <Label>What your company does</Label>
                  <textarea
                    rows={3}
                    value={description}
                    disabled={!isAdmin}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. LSI Media builds AI marketing systems for nonprofits — automated donor outreach, grant discovery, and campaign analytics."
                    className={cn("w-full rounded-md border px-3 py-2 text-[13px] outline-none", isAdmin ? "border-border bg-background focus:ring-2 focus:ring-ring" : "border-border/60 bg-muted/50 text-muted-foreground/80")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Value proposition</Label>
                  <textarea
                    rows={2}
                    value={valueProp}
                    disabled={!isAdmin}
                    onChange={(e) => setValueProp(e.target.value)}
                    placeholder="The core promise you lead with — e.g. 'Book 3× more donor meetings without adding headcount.'"
                    className={cn("w-full rounded-md border px-3 py-2 text-[13px] outline-none", isAdmin ? "border-border bg-background focus:ring-2 focus:ring-ring" : "border-border/60 bg-muted/50 text-muted-foreground/80")}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Industry</Label>
                    <Input value={industry} disabled={!isAdmin} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Marketing technology" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Website</Label>
                    <Input value={website} disabled={!isAdmin} onChange={(e) => setWebsite(e.target.value)} placeholder="lsi-media.com" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Keywords <span className="text-muted-foreground font-normal">— words that describe your company</span></Label>
                  <TagInput value={keywords} onChange={setKeywords} disabled={!isAdmin} placeholder="Type a keyword and press Enter" />
                </div>
                <div className="space-y-1.5">
                  <Label>Topics <span className="text-muted-foreground font-normal">— themes to emphasise in outreach</span></Label>
                  <TagInput value={topics} onChange={setTopics} disabled={!isAdmin} placeholder="Type a topic and press Enter" />
                </div>
              </Card>

              {/* Brand voice */}
              <Card title="Brand voice" description="How your outreach sounds. Applied to AI-generated emails and sequences when the toggle below is on.">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
                  <div>
                    <div className="text-[13px] font-medium">Apply brand voice to AI</div>
                    <div className="text-[12px] text-muted-foreground">When off, AI writers ignore the voice + company profile above.</div>
                  </div>
                  <Switch checked={applyToAI} disabled={!isAdmin} onCheckedChange={setApplyToAI} />
                </div>
                <div className="space-y-1.5 max-w-xs">
                  <Label>Tone</Label>
                  <select
                    value={tone}
                    disabled={!isAdmin}
                    onChange={(e) => setTone(e.target.value as Tone)}
                    className={cn("w-full rounded-md border px-3 py-2 text-[13px] outline-none capitalize", isAdmin ? "border-border bg-background focus:ring-2 focus:ring-ring" : "border-border/60 bg-muted/50 text-muted-foreground/80")}
                  >
                    {TONES.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Preferred words / phrases</Label>
                  <TagInput value={vocabulary} onChange={setVocabulary} disabled={!isAdmin} placeholder="Words the AI should favour" />
                </div>
                <div className="space-y-1.5">
                  <Label>Words to avoid</Label>
                  <TagInput value={avoidWords} onChange={setAvoidWords} disabled={!isAdmin} placeholder="Words the AI should never use" />
                </div>
              </Card>

              {/* Personas — link-out to the full editor */}
              <Card title="Personas" description="Reusable target-audience profiles (titles, industries, size, geo, keywords) applied to campaigns and searches.">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/personas")}>
                  <Users className="size-3.5" /> Manage personas <ExternalLink className="size-3.5 opacity-60" />
                </Button>
              </Card>

              {/* Social accounts — honest placeholder */}
              <Card title="Social accounts" description="Connect your workspace's social profiles for branded outreach.">
                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-[13px] text-muted-foreground">
                  <Share2 className="size-4 shrink-0" />
                  Coming soon — you'll be able to add your workspace's social accounts here.
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
