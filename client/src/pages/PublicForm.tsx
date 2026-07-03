/**
 * PublicForm — the hosted, unauthenticated lead-capture form at /f/:publicId.
 *
 * Renders a form defined in the `forms` table (via the public forms.getByPublicId)
 * and posts to the public forms.submit mutation, which autonomously creates +
 * routes + enrolls a lead. No Shell, no auth — standalone page.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Loader2 } from "lucide-react";

type Field = { key: string; label: string; required?: boolean };

export default function PublicForm() {
  const [, params] = useRoute("/f/:publicId");
  const publicId = params?.publicId ?? "";

  const form = trpc.forms.getByPublicId.useQuery({ publicId }, { enabled: !!publicId, retry: false });
  const submit = trpc.forms.submit.useMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const fields: Field[] = useMemo(() => {
    const f = form.data?.fields;
    return Array.isArray(f) ? (f as Field[]) : [];
  }, [form.data]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit.mutate({ publicId, data: values }, {
      onSuccess: (r: any) => {
        if (r?.redirectUrl) { window.location.href = r.redirectUrl; return; }
        setDone(true);
      },
    });
  };

  const inputType = (key: string) => (key === "email" ? "email" : key === "phone" ? "tel" : "text");

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card shadow-sm p-6">
        {form.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : !form.data ? (
          <div className="text-center py-10">
            <div className="text-sm font-medium">Form not available</div>
            <p className="text-xs text-muted-foreground mt-1">This form may have been paused or removed.</p>
          </div>
        ) : done ? (
          <div className="text-center py-10">
            <CheckCircle2 className="size-10 mx-auto text-emerald-500 mb-3" />
            <div className="text-base font-semibold">Thanks!</div>
            <p className="text-sm text-muted-foreground mt-1">We’ve received your details and will be in touch shortly.</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{form.data.title}</h1>
              {form.data.description && <p className="text-sm text-muted-foreground mt-1">{form.data.description}</p>}
            </div>
            <div className="space-y-3">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`f-${f.key}`}>{f.label}{f.required ? " *" : ""}</Label>
                  {f.key === "message" ? (
                    <Textarea id={`f-${f.key}`} rows={3} required={f.required}
                      value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  ) : (
                    <Input id={`f-${f.key}`} type={inputType(f.key)} required={f.required}
                      value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  )}
                </div>
              ))}
            </div>
            {submit.error && <p className="text-xs text-rose-600">{submit.error.message}</p>}
            <Button type="submit" className="w-full" disabled={submit.isPending}>
              {submit.isPending ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Submitting…</> : "Submit"}
            </Button>
            <p className="text-[10px] text-center text-muted-foreground">Powered by Velocity</p>
          </form>
        )}
      </div>
    </div>
  );
}
