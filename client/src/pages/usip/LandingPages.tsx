/**
 * LandingPages — Admin-only builder for publicly-hosted marketing pages
 * (/v2/landing-pages). Create a page, edit its hero/sections/lead-form, publish
 * it, and share the public /l/:slug URL. Management is Admin-only (the router
 * enforces it too); non-admins see a gate.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/usip/Common";
import {
  LayoutTemplate, Plus, Trash2, Copy, ExternalLink, Check, Globe, Eye, Send, Loader2, GripVertical,
} from "lucide-react";

const ALL_FIELDS = [
  { key: "name", label: "Full name" },
  { key: "email", label: "Work email" },
  { key: "company", label: "Company" },
  { key: "phone", label: "Phone" },
  { key: "message", label: "Message" },
];

type Section = { heading: string; body: string };
type FormField = { key: string; label: string; required?: boolean };

export default function LandingPages() {
  const accent = useAccentColor();
  const { current } = useWorkspace();
  const isAdmin = current?.role === "admin" || current?.role === "super_admin";

  const utils = trpc.useUtils();
  const list = trpc.landingPages.list.useQuery(undefined as any, { retry: false, enabled: isAdmin });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = trpc.landingPages.get.useQuery({ id: selectedId! }, { enabled: isAdmin && !!selectedId, retry: false });
  const seqQ = trpc.sequences.list.useQuery(undefined as any, { enabled: isAdmin, retry: false });
  const sequences = ((seqQ.data as any[]) ?? []).filter((s) => s.status !== "archived");
  const subsQ = trpc.landingPages.submissions.useQuery({ id: selectedId! }, { enabled: isAdmin && !!selectedId, retry: false });
  const submissions = (subsQ.data as any[]) ?? [];

  const create = trpc.landingPages.create.useMutation({
    onSuccess: (r: any) => { utils.landingPages.list.invalidate(); setSelectedId(r.id); toast.success("Landing page created"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const update = trpc.landingPages.update.useMutation({
    onSuccess: () => { utils.landingPages.list.invalidate(); utils.landingPages.get.invalidate(); toast.success("Saved"); },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });
  const setStatus = trpc.landingPages.setStatus.useMutation({
    onSuccess: () => { utils.landingPages.list.invalidate(); utils.landingPages.get.invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const remove = trpc.landingPages.remove.useMutation({
    onSuccess: () => { utils.landingPages.list.invalidate(); setSelectedId(null); toast.success("Deleted"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  // ── Editor local state ──
  const [form, setForm] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (detail.data) setForm({ ...detail.data, sections: detail.data.sections ?? [], formFields: detail.data.formFields ?? [] });
  }, [detail.data]);

  const pages = (list.data as any[]) ?? [];
  const publicUrl = form?.slug ? `${window.location.origin}/l/${form.slug}` : "";
  const patch = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const save = () => {
    if (!form) return;
    update.mutate({
      id: form.id,
      name: form.name, headline: form.headline, subheadline: form.subheadline,
      heroImageUrl: form.heroImageUrl, themeColor: form.themeColor,
      sections: (form.sections as Section[]).filter((s) => s.heading || s.body),
      seoDescription: form.seoDescription, formHeading: form.formHeading,
      ctaButtonLabel: form.ctaButtonLabel, formFields: form.formFields,
      autoCreateLead: form.autoCreateLead, autoRoute: form.autoRoute,
      autoEnrollSequenceId: form.autoEnrollSequenceId ?? null,
      redirectUrl: form.redirectUrl, showBookingCta: form.showBookingCta,
    } as any);
  };

  const toggleField = (key: string, label: string) => {
    const cur: FormField[] = form.formFields ?? [];
    const has = cur.some((f) => f.key === key);
    patch("formFields", has ? cur.filter((f) => f.key !== key) : [...cur, { key, label, required: key === "email" }]);
  };

  if (!isAdmin) {
    return (
      <Shell title="Landing Pages">
        <div className="h-full flex items-center justify-center p-6 text-center">
          <div>
            <Globe className="size-8 mx-auto text-muted-foreground opacity-50 mb-3" />
            <div className="text-sm font-semibold">Admins only</div>
            <p className="text-sm text-muted-foreground mt-1">Landing page creation is restricted to workspace admins.</p>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Landing Pages">
      <div className="flex h-full min-h-0">
        {/* List */}
        <aside className="w-72 shrink-0 border-r border-border flex flex-col bg-card/40">
          <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-border">
            <LayoutTemplate className="size-4" style={{ color: accent }} />
            <span className="text-sm font-semibold">Landing Pages</span>
            <div className="flex-1" />
            <Button size="sm" className="h-7 gap-1" style={{ backgroundColor: accent }}
              disabled={create.isPending} onClick={() => create.mutate({ name: "Untitled landing page", headline: "Your headline here" } as any)}>
              <Plus className="size-3.5" /> New
            </Button>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {pages.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">No landing pages yet. Click <b>New</b> to create one.</p>
            ) : pages.map((p) => (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${selectedId === p.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium truncate flex-1">{p.name}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${p.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{p.status}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-0.5"><Eye className="size-3" /> {p.viewCount}</span>
                  <span className="inline-flex items-center gap-0.5"><Send className="size-3" /> {p.submitCount}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Editor */}
        <div className="flex-1 min-w-0 overflow-auto">
          {!form ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              {selectedId ? <Loader2 className="size-5 animate-spin" /> : "Select a page, or create a new one."}
            </div>
          ) : (
            <div className="max-w-2xl mx-auto p-6 space-y-6">
              {/* Header actions */}
              <div className="flex items-center gap-2">
                <Input value={form.name} onChange={(e) => patch("name", e.target.value)} className="h-9 text-base font-semibold flex-1" />
                {form.status === "published" ? (
                  <Button variant="outline" size="sm" className="h-8" onClick={() => setStatus.mutate({ id: form.id, status: "draft" })}>Unpublish</Button>
                ) : (
                  <Button size="sm" className="h-8 gap-1" style={{ backgroundColor: accent }} onClick={() => setStatus.mutate({ id: form.id, status: "published" })}><Globe className="size-3.5" /> Publish</Button>
                )}
                <Button size="sm" className="h-8" disabled={update.isPending} onClick={save}>Save</Button>
              </div>

              {/* Public URL */}
              <div className="rounded-lg border bg-card p-3 flex items-center gap-2">
                <Globe className="size-4 shrink-0" style={{ color: accent }} />
                <code className="text-[12px] truncate flex-1">{publicUrl}</code>
                <Button variant="outline" size="sm" className="h-7 gap-1 shrink-0" onClick={() => { navigator.clipboard?.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                  {copied ? <><Check className="size-3.5" /> Copied</> : <><Copy className="size-3.5" /> Copy</>}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 gap-1 shrink-0" disabled={form.status !== "published"} onClick={() => window.open(publicUrl, "_blank")}><ExternalLink className="size-3.5" /> View</Button>
              </div>

              {/* Hero */}
              <Section title="Hero">
                <Field label="Headline"><Input value={form.headline ?? ""} onChange={(e) => patch("headline", e.target.value)} /></Field>
                <Field label="Subheadline"><Textarea rows={2} value={form.subheadline ?? ""} onChange={(e) => patch("subheadline", e.target.value)} /></Field>
                <Field label="Hero image URL"><Input value={form.heroImageUrl ?? ""} onChange={(e) => patch("heroImageUrl", e.target.value)} placeholder="https://…" /></Field>
                <Field label="Theme color">
                  <div className="flex items-center gap-2">
                    <input type="color" value={form.themeColor ?? "#14B89A"} onChange={(e) => patch("themeColor", e.target.value)} className="h-9 w-14 rounded border" />
                    <Input value={form.themeColor ?? ""} onChange={(e) => patch("themeColor", e.target.value)} className="w-32" />
                  </div>
                </Field>
              </Section>

              {/* Content sections */}
              <Section title="Content sections">
                {(form.sections as Section[]).map((s, i) => (
                  <div key={i} className="rounded-lg border p-3 space-y-2 relative">
                    <div className="flex items-center gap-2">
                      <GripVertical className="size-4 text-muted-foreground" />
                      <Input placeholder="Section heading" value={s.heading} onChange={(e) => { const n = [...form.sections]; n[i] = { ...s, heading: e.target.value }; patch("sections", n); }} className="flex-1" />
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => patch("sections", form.sections.filter((_: any, j: number) => j !== i))}><Trash2 className="size-4" /></Button>
                    </div>
                    <Textarea rows={3} placeholder="Section body" value={s.body} onChange={(e) => { const n = [...form.sections]; n[i] = { ...s, body: e.target.value }; patch("sections", n); }} />
                  </div>
                ))}
                <Button variant="outline" size="sm" className="gap-1" onClick={() => patch("sections", [...form.sections, { heading: "", body: "" }])}><Plus className="size-3.5" /> Add section</Button>
              </Section>

              {/* Lead form */}
              <Section title="Lead-capture form">
                <Field label="Form heading"><Input value={form.formHeading ?? ""} onChange={(e) => patch("formHeading", e.target.value)} /></Field>
                <Field label="Submit button label"><Input value={form.ctaButtonLabel ?? ""} onChange={(e) => patch("ctaButtonLabel", e.target.value)} /></Field>
                <Field label="Fields to collect">
                  <div className="flex flex-wrap gap-2">
                    {ALL_FIELDS.map((f) => {
                      const on = (form.formFields ?? []).some((x: FormField) => x.key === f.key);
                      return (
                        <button key={f.key} type="button" onClick={() => toggleField(f.key, f.label)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${on ? "text-white border-transparent" : "text-muted-foreground hover:bg-muted"}`}
                          style={on ? { backgroundColor: accent } : undefined}>{f.label}</button>
                      );
                    })}
                  </div>
                </Field>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Auto-create lead on submit</Label>
                  <Switch checked={!!form.autoCreateLead} onCheckedChange={(v) => patch("autoCreateLead", v)} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Auto-route to an owner</Label>
                  <Switch checked={!!form.autoRoute} onCheckedChange={(v) => patch("autoRoute", v)} />
                </div>
                <Field label="Auto-enroll new leads into a sequence">
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={form.autoEnrollSequenceId ?? ""}
                    onChange={(e) => patch("autoEnrollSequenceId", e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">None — capture only</option>
                    {sequences.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">Captured leads are enrolled automatically → autonomous outreach → booked meeting.</p>
                </Field>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Show "Book a meeting" button</Label>
                    <p className="text-[11px] text-muted-foreground">Adds a CTA linking to your self-serve booking page.</p>
                  </div>
                  <Switch checked={!!form.showBookingCta} onCheckedChange={(v) => patch("showBookingCta", v)} />
                </div>
                <Field label="Redirect URL after submit (optional)"><Input value={form.redirectUrl ?? ""} onChange={(e) => patch("redirectUrl", e.target.value)} placeholder="https://… (leave blank for a thank-you message)" /></Field>
              </Section>

              {/* SEO + danger */}
              <Section title="SEO & metadata">
                <Field label="Meta description"><Textarea rows={2} value={form.seoDescription ?? ""} onChange={(e) => patch("seoDescription", e.target.value)} /></Field>
              </Section>

              {/* Captured leads */}
              <Section title={`Submissions${submissions.length ? ` (${submissions.length})` : ""}`}>
                {subsQ.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : submissions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No submissions yet. Share the public URL to start capturing leads.</p>
                ) : (
                  <div className="rounded-lg border divide-y divide-border/60 max-h-64 overflow-auto">
                    {submissions.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                        <span className="font-medium truncate">{`${l.firstName ?? ""} ${l.lastName ?? ""}`.trim() || "Unknown"}</span>
                        {l.email && <span className="text-muted-foreground truncate">· {l.email}</span>}
                        {l.company && <span className="text-muted-foreground truncate hidden sm:inline">· {l.company}</span>}
                        <span className="flex-1" />
                        <span className="text-[11px] text-muted-foreground shrink-0">{l.createdAt ? new Date(l.createdAt).toLocaleDateString() : ""}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <div className="flex items-center justify-between pt-2 border-t">
                <Button variant="ghost" size="sm" className="text-rose-600 gap-1" onClick={() => { confirmAction({ title: "Delete this landing page?" }, () => { remove.mutate({ id: form.id }); }); }}><Trash2 className="size-4" /> Delete page</Button>
                <Button size="sm" disabled={update.isPending} onClick={save} style={{ backgroundColor: accent }} className="text-white">Save changes</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">{label}</Label>
      {children}
    </div>
  );
}
