/**
 * The persona form, shared by the Personas page and a sector's Personas
 * section. Targeting (titles, industries, size, keywords) says who to find;
 * the research fields (cares, pains, objections, angle; migration 0201) say
 * what the AI writers should know about them.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LinesInput, TagInput } from "./ResearchFields";
import { icpLabels } from "@shared/icpShape";

export interface PersonaForm {
  name: string;
  description: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeographies: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  keywords: string[];
  categoryId: number | null;
  sectorId: number | null;
  cares: string;
  pains: string[];
  objections: string[];
  angle: string;
}

export const EMPTY_PERSONA: PersonaForm = {
  name: "",
  description: "",
  targetTitles: [],
  targetIndustries: [],
  targetGeographies: [],
  employeeMin: null,
  employeeMax: null,
  keywords: [],
  categoryId: null,
  sectorId: null,
  cares: "",
  pains: [],
  objections: [],
  angle: "",
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A stored persona row as the form edits it. */
export function personaFormFrom(p: any): PersonaForm {
  return {
    name: p.name ?? "",
    description: p.description ?? "",
    targetTitles: icpLabels(p.targetTitles, "title"),
    targetIndustries: icpLabels(p.targetIndustries, "industry"),
    targetGeographies: icpLabels(p.targetGeographies, "geography"),
    employeeMin: p.employeeMin ?? null,
    employeeMax: p.employeeMax ?? null,
    keywords: strings(p.keywords),
    categoryId: p.categoryId ?? null,
    sectorId: p.sectorId ?? null,
    cares: p.cares ?? "",
    pains: strings(p.pains),
    objections: strings(p.objections),
    angle: p.angle ?? "",
  };
}

/** The form as the personas router takes it: blank lines dropped. */
export function personaPayload(form: PersonaForm) {
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return { ...form, pains: clean(form.pains), objections: clean(form.objections) };
}

export function PersonaFormFields({ form, setForm, categories, sectors }: {
  form: PersonaForm;
  setForm: (f: PersonaForm) => void;
  /** Omit to hide the category picker. */
  categories?: { id: number; name: string }[];
  /** Omit to hide the sector picker (a sector's own page fixes it). */
  sectors?: { id: number; name: string; marketName: string }[];
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Name</Label>
        <Input aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Director of Federal Programs" />
      </div>
      {(categories || sectors) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {categories && (
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={form.categoryId != null ? String(form.categoryId) : "none"}
                onValueChange={(v) => setForm({ ...form, categoryId: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger><SelectValue placeholder="Uncategorized" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorized</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {sectors && (
            <div className="space-y-2">
              <Label>Sector</Label>
              <Select
                value={form.sectorId != null ? String(form.sectorId) : "none"}
                onValueChange={(v) => setForm({ ...form, sectorId: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger><SelectValue placeholder="No sector" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No sector</SelectItem>
                  {sectors.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.marketName} › {s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label>Description</Label>
        <Textarea aria-label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
      </div>

      <div className="rounded-md border p-3 space-y-4">
        <div>
          <div className="text-sm font-medium">Who to find</div>
          <p className="text-xs text-muted-foreground">Copied into a campaign's targeting when you start one from this persona.</p>
        </div>
        <TagInput label="Job titles" value={form.targetTitles} onChange={(v) => setForm({ ...form, targetTitles: v })} placeholder="VP of Sales…" />
        <TagInput label="Industries" value={form.targetIndustries} onChange={(v) => setForm({ ...form, targetIndustries: v })} placeholder="SaaS, Fintech…" />
        <TagInput label="Locations" value={form.targetGeographies} onChange={(v) => setForm({ ...form, targetGeographies: v })} placeholder="United States, UK…" />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Min employees</Label>
            <Input aria-label="Min employees" type="number" value={form.employeeMin ?? ""} onChange={(e) => setForm({ ...form, employeeMin: e.target.value ? Number(e.target.value) : null })} />
          </div>
          <div className="space-y-2">
            <Label>Max employees</Label>
            <Input aria-label="Max employees" type="number" value={form.employeeMax ?? ""} onChange={(e) => setForm({ ...form, employeeMax: e.target.value ? Number(e.target.value) : null })} />
          </div>
        </div>
        <TagInput label="Keywords" value={form.keywords} onChange={(v) => setForm({ ...form, keywords: v })} placeholder="revenue ops, salesforce…" />
      </div>

      <div className="rounded-md border p-3 space-y-4">
        <div>
          <div className="text-sm font-medium">What to know about them</div>
          <p className="text-xs text-muted-foreground">Describe the role, never a named person. No emails or phone numbers.</p>
        </div>
        <div className="space-y-2">
          <Label>What they care about</Label>
          <Textarea aria-label="What they care about" rows={2} value={form.cares} onChange={(e) => setForm({ ...form, cares: e.target.value })} placeholder="Keeping funds compliant and spent on time." />
        </div>
        <LinesInput label="Pains" hint="One per line." value={form.pains} onChange={(v) => setForm({ ...form, pains: v })} rows={3} placeholder="Late allocations" />
        <LinesInput label="Objections" hint="One per line." value={form.objections} onChange={(v) => setForm({ ...form, objections: v })} rows={3} placeholder="Another system to learn" />
        <div className="space-y-2">
          <Label>Angle that works</Label>
          <Textarea aria-label="Angle that works" rows={2} value={form.angle} onChange={(e) => setForm({ ...form, angle: e.target.value })} placeholder="Show the audit trail." />
        </div>
      </div>
    </div>
  );
}
