/**
 * Brand Voice — configure tone, style, and persona for AI-generated emails
 */
import { useState, useEffect } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Mic2, Save, Plus, Palette } from "lucide-react";

type BrandTone = "professional" | "conversational" | "direct" | "empathetic" | "authoritative";
const TONE_OPTIONS: BrandTone[] = ["professional", "conversational", "direct", "empathetic", "authoritative"];

interface BrandVoiceForm {
  tone: BrandTone;
  vocabulary: string[];
  avoidWords: string[];
  signatureHtml: string;
  fromName: string;
  fromEmail: string;
  primaryColor: string;
  secondaryColor: string;
  applyToAI: boolean;
}

const DEFAULT_FORM: BrandVoiceForm = {
  tone: "professional",
  vocabulary: [],
  avoidWords: [],
  signatureHtml: "",
  fromName: "",
  fromEmail: "",
  primaryColor: "#14B89A",
  secondaryColor: "#0F766E",
  applyToAI: true,
};

function WordChips({
  label,
  words,
  onChange,
  placeholder,
  colorClass,
}: {
  label: string;
  words: string[];
  onChange: (words: string[]) => void;
  placeholder: string;
  colorClass: string;
}) {
  const [input, setInput] = useState("");

  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !words.includes(trimmed)) {
      onChange([...words, trimmed]);
    }
    setInput("");
  };

  return (
    <div className="space-y-2">
      <Label className={colorClass.includes("green") ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
        {label}
      </Label>
      <div className="flex flex-wrap gap-1.5 min-h-[32px]">
        {words.map((w) => (
          <Badge key={w} variant="secondary" className={`${colorClass} text-xs gap-1`}>
            {w}
            <button onClick={() => onChange(words.filter((x) => x !== w))} className="ml-0.5 hover:opacity-70">×</button>
          </Badge>
        ))}
        {words.length === 0 && <span className="text-xs text-muted-foreground italic">None added yet</span>}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={add} disabled={!input.trim()}>
          <Plus size={12} />
        </Button>
      </div>
    </div>
  );
}

export default function BrandVoicePage() {
  const { data: profile, isLoading } = trpc.brandVoice.get.useQuery();
  const [form, setForm] = useState<BrandVoiceForm>(DEFAULT_FORM);
  const [isDirty, setIsDirty] = useState(false);

  const utils = trpc.useUtils();

  const saveMutation = trpc.brandVoice.save.useMutation({
    onSuccess: () => {
      utils.brandVoice.get.invalidate();
      setIsDirty(false);
      toast.success("Brand voice saved");
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Load profile on mount
  useEffect(() => {
    if (profile) {
      setForm({
        tone: (profile.tone as BrandTone) ?? "professional",
        vocabulary: (profile.vocabulary as string[]) ?? [],
        avoidWords: (profile.avoidWords as string[]) ?? [],
        signatureHtml: profile.signatureHtml ?? "",
        fromName: profile.fromName ?? "",
        fromEmail: profile.fromEmail ?? "",
        primaryColor: profile.primaryColor ?? "#14B89A",
        secondaryColor: profile.secondaryColor ?? "#0F766E",
        applyToAI: profile.applyToAI ?? true,
      });
    }
  }, [profile]);

  const setField = <K extends keyof BrandVoiceForm>(key: K, val: BrandVoiceForm[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
    setIsDirty(true);
  };

  const handleSave = () => {
    saveMutation.mutate({
      tone: form.tone,
      vocabulary: form.vocabulary,
      avoidWords: form.avoidWords,
      signatureHtml: form.signatureHtml || undefined,
      fromName: form.fromName || undefined,
      fromEmail: form.fromEmail || undefined,
      primaryColor: form.primaryColor,
      secondaryColor: form.secondaryColor,
      applyToAI: form.applyToAI,
    });
  };

  if (isLoading) {
    return (
      <Shell title="Brand Voice">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Brand Voice">
      <PageHeader
        title="Brand Voice"
        description="Define the tone, style, and persona for AI-generated emails"
      >
        <Button size="sm" onClick={handleSave} disabled={!isDirty || saveMutation.isPending}>
          <Save size={14} className="mr-1.5" /> {saveMutation.isPending ? "Saving…" : "Save Changes"}
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: config */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Writing Tone</CardTitle>
              <CardDescription>How the AI will sound in generated emails</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <div className="flex flex-wrap gap-2">
                  {TONE_OPTIONS.map((t) => (
                    <button
                      key={t}
                      onClick={() => setField("tone", t)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${
                        form.tone === t
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted hover:bg-muted/80"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="applyToAI"
                  checked={form.applyToAI}
                  onChange={(e) => setField("applyToAI", e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="applyToAI" className="cursor-pointer">Apply this brand voice to all AI-generated emails</Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Vocabulary Control</CardTitle>
              <CardDescription>Guide the AI to use or avoid specific words and phrases</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <WordChips
                label="Preferred Words / Phrases"
                words={form.vocabulary}
                onChange={(w) => setField("vocabulary", w)}
                placeholder="Add preferred word…"
                colorClass="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              />
              <Separator />
              <WordChips
                label="Words / Phrases to Avoid"
                words={form.avoidWords}
                onChange={(w) => setField("avoidWords", w)}
                placeholder="Add word to avoid…"
                colorClass="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Email Identity</CardTitle>
              <CardDescription>Default sender name and email for outbound emails</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>From Name</Label>
                  <Input
                    value={form.fromName}
                    onChange={(e) => setField("fromName", e.target.value)}
                    placeholder="e.g. Alex from USIP"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>From Email</Label>
                  <Input
                    type="email"
                    value={form.fromEmail}
                    onChange={(e) => setField("fromEmail", e.target.value)}
                    placeholder="alex@yourcompany.com"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Email Signature (HTML)</Label>
                <Textarea
                  value={form.signatureHtml}
                  onChange={(e) => setField("signatureHtml", e.target.value)}
                  placeholder="<p>Best,<br/>Alex Johnson<br/>Account Executive</p>"
                  className="min-h-[100px] resize-y text-sm font-mono"
                />
                <p className="text-xs text-muted-foreground">HTML is supported. This signature will be appended to all outbound emails.</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: brand colors + summary */}
        <div className="space-y-4">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Palette size={15} /> Brand Colors
              </CardTitle>
              <CardDescription>Used in email templates and visual builder</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Primary Color</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.primaryColor}
                    onChange={(e) => setField("primaryColor", e.target.value)}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={form.primaryColor}
                    onChange={(e) => {
                      if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) {
                        setField("primaryColor", e.target.value);
                      }
                    }}
                    className="font-mono text-sm flex-1"
                    maxLength={7}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Secondary Color</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.secondaryColor}
                    onChange={(e) => setField("secondaryColor", e.target.value)}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={form.secondaryColor}
                    onChange={(e) => {
                      if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) {
                        setField("secondaryColor", e.target.value);
                      }
                    }}
                    className="font-mono text-sm flex-1"
                    maxLength={7}
                  />
                </div>
              </div>

              {/* Preview swatch */}
              <div
                className="rounded-lg p-4 text-white text-sm font-medium text-center"
                style={{ background: `linear-gradient(135deg, ${form.primaryColor}, ${form.secondaryColor})` }}
              >
                <Mic2 size={20} className="mx-auto mb-1.5" />
                Brand Voice Preview
              </div>

              <Separator />

              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Current Settings</p>
                <div className="space-y-1">
                  {[
                    { label: "Tone", value: form.tone },
                    { label: "Apply to AI", value: form.applyToAI ? "Yes" : "No" },
                    { label: "Preferred", value: form.vocabulary.length ? `${form.vocabulary.length} words` : "None" },
                    { label: "Avoid", value: form.avoidWords.length ? `${form.avoidWords.length} words` : "None" },
                    { label: "Signature", value: form.signatureHtml ? "Configured" : "Not set" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium capitalize">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Shell>
  );
}
