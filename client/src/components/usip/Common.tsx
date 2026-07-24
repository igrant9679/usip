import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/* ─────────────────────── promise-based confirm ──────────────────────────
 * `ConfirmButton` below only fits when the action hangs off a button you own.
 * Plenty of destructive actions live in a plain handler instead
 * (`const del = (x) => { … }`, bulk-toolbar callbacks, dropdown items), and
 * those historically fell back to the NATIVE confirm() — which blocks the
 * renderer thread, freezing the whole app until it's dismissed, can't be
 * styled, and is invisible to anything driving the page.
 *
 * useConfirm() gives those call sites an in-app AlertDialog:
 *     if (confirm("Delete?")) del()              →  native, blocking
 *     confirm({ title: "Delete?" }, () => del()) →  in-app, non-blocking
 *
 * The API takes a CALLBACK rather than returning a promise on purpose. A
 * promise-returning confirm() invites `if (confirm(...))` — which is always
 * truthy when the await is forgotten, silently running the destructive action
 * with no confirmation at all. With a callback there is no boolean to test,
 * so that failure mode cannot be written.
 * ---------------------------------------------------------------------- */

export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions, onAccept: () => void) => void;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/* Module-level binding so NON-component code (plain handlers, callbacks
 * defined outside a component body) can raise the same dialog without being
 * rewritten into a hook call. ConfirmProvider registers itself here on mount.
 * If it somehow isn't mounted we log and do NOTHING — never run the action
 * unconfirmed, since every caller is a destructive operation. */
let boundConfirm: ConfirmFn | null = null;

export const confirmAction: ConfirmFn = (opts, onAccept) => {
  if (!boundConfirm) {
    console.error("[confirmAction] ConfirmProvider is not mounted — action cancelled:", opts.title);
    return;
  }
  boundConfirm(opts, onAccept);
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  // Held across renders so the dialog's buttons can reach the pending action.
  const action = useRef<(() => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o, onAccept) => {
    action.current = onAccept;
    setOpts(o);
  }, []);

  // Expose the same function to the module-level confirmAction() binding.
  useEffect(() => {
    boundConfirm = confirm;
    return () => { if (boundConfirm === confirm) boundConfirm = null; };
  }, [confirm]);

  const settle = (accepted: boolean) => {
    const run = action.current;
    action.current = null;
    setOpts(null);
    if (accepted) run?.();
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={!!opts}
        // Covers Esc and outside-click — both must drop the pending action.
        onOpenChange={(open) => { if (!open) settle(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            {opts?.description && <AlertDialogDescription>{opts.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{opts?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              className={opts?.destructive !== false ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={() => settle(true)}
            >
              {opts?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/** Returns confirm(opts, onAccept). Throws if the provider isn't mounted,
 *  rather than silently running a destructive action unconfirmed. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

/**
 * Drop-in button that requires confirmation before running a destructive or
 * irreversible action (delete / send / publish / rotate / role-change). The
 * button's content is passed as children; `onConfirm` fires only after the
 * user accepts the dialog. Standardizes the three inconsistent patterns
 * (AlertDialog / window.confirm / none) the UX audit found across the app.
 */
export function ConfirmButton({
  onConfirm,
  title = "Are you sure?",
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "ghost",
  size = "sm",
  destructive = true,
  disabled,
  className,
  ariaLabel,
  children,
}: {
  onConfirm: () => void;
  title?: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "ghost" | "outline" | "destructive" | "secondary";
  size?: "sm" | "default" | "icon";
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant={variant} size={size} disabled={disabled} className={className} aria-label={ariaLabel}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            onClick={() => onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

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
