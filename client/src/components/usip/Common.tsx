import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ReactNode, useState } from "react";

export function Section({ title, description, right, children }: { title: string; description?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b flex items-center gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
        </div>
        {right}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function StatusPill({ tone = "default", children }: { tone?: "default" | "success" | "warning" | "danger" | "info" | "muted"; children: ReactNode }) {
  const cls =
    tone === "success" ? "bg-emerald-100 text-emerald-800"
    : tone === "warning" ? "bg-amber-100 text-amber-800"
    : tone === "danger" ? "bg-rose-100 text-rose-800"
    : tone === "info" ? "bg-blue-100 text-blue-800"
    : tone === "muted" ? "bg-secondary text-muted-foreground"
    : "bg-secondary text-foreground";
  return <span className={cn("inline-block px-1.5 py-0.5 rounded text-[11px] font-medium", cls)}>{children}</span>;
}

export function FormDialog({
  open, onOpenChange, title, onSubmit, children, submitLabel = "Save", isPending,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string;
  onSubmit: (form: FormData) => void; children: ReactNode; submitLabel?: string; isPending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
          className="space-y-3"
        >
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Field({ name, label, type = "text", required, placeholder, defaultValue, value, onChange }: { name: string; label: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string | number; value?: string; onChange?: (e: any) => void }) {
  const controlled = value !== undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      {controlled
        ? <Input id={name} name={name} type={type} required={required} placeholder={placeholder} value={value} onChange={onChange} />
        : <Input id={name} name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue} />}
    </div>
  );
}

export function TextareaField({ name, label, required, placeholder, defaultValue, rows = 4, value, onChange }: { name: string; label: string; required?: boolean; placeholder?: string; defaultValue?: string; rows?: number; value?: string; onChange?: (e: any) => void }) {
  const controlled = value !== undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <textarea
        id={name}
        name={name}
        required={required}
        placeholder={placeholder}
        rows={rows}
        {...(controlled ? { value, onChange } : { defaultValue })}
        className="w-full text-sm rounded-md border bg-background px-3 py-2 font-sans"
      />
    </div>
  );
}

export function SelectField({ name, label, options, defaultValue }: { name: string; label: string; options: { value: string; label: string }[]; defaultValue?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <select id={name} name={name} defaultValue={defaultValue} className="w-full text-sm rounded-md border bg-background px-3 py-2 h-10">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [v, set] = useState(initial);
  return [v, () => set((p) => !p), set];
}

export function fmt$(n: number | null | undefined) {
  return `$${(Number(n ?? 0)).toLocaleString()}`;
}

export function fmtDate(d: Date | string | number | null | undefined) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString();
}
