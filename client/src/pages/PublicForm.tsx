/**
 * PublicForm — the hosted, unauthenticated lead-capture form at /f/:publicId.
 *
 * Renders a form defined in the `forms` table (via the public forms.getByPublicId)
 * and posts to the public forms.submit mutation, which autonomously creates +
 * routes + enrolls a lead. No Shell, no auth — standalone page.
 */
import { useEffect, useMemo, useState } from "react";
import { HONEYPOT_FIELD } from "@shared/publicForm";
import { HoneypotField } from "@/components/usip/HoneypotField";
import { useCaptureGuard } from "@/components/usip/CaptureGuard";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { safeRedirectUrl } from "@shared/safeRedirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Loader2 } from "lucide-react";
import { usePageTitle } from "@/lib/usePageTitle";

type Field = { key: string; label: string; required?: boolean };

export default function PublicForm() {
  const [, params] = useRoute("/f/:publicId");
  const publicId = params?.publicId ?? "";

  const form = trpc.forms.getByPublicId.useQuery({ publicId }, { enabled: !!publicId, retry: false, refetchOnWindowFocus: false });
  usePageTitle(form.data?.title);
  const submit = trpc.forms.submit.useMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  // Bot checks (F47): the first submit token served, and Turnstile when set up.
  const guard = useCaptureGuard(form.data);
  // A counter, not a message: a failed count shows the visitor nothing.
  const recordView = trpc.forms.recordView.useMutation({ meta: { silentError: true } });

  /**
   * Count this view once the form has rendered (F47, the landing page's L12
   * rule): once a day per form from this browser, and the server keeps its own
   * once-a-day check. Crawlers and link previews never run this.
   */
  useEffect(() => {
    if (!form.data || !publicId) return;
    const day = new Date().toISOString().slice(0, 10);
    let visitor = "";
    try {
      if (localStorage.getItem(`f-viewed:${publicId}`) === day) return;
      visitor = localStorage.getItem("lp-visitor") || "";
      if (!visitor) {
        visitor = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("lp-visitor", visitor);
      }
      localStorage.setItem(`f-viewed:${publicId}`, day);
    } catch { /* storage blocked: the server-side check still holds */ }
    recordView.mutate({ publicId, visitor: visitor || undefined });
  }, [form.data, publicId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields: Field[] = useMemo(() => {
    const f = form.data?.fields;
    return Array.isArray(f) ? (f as Field[]) : [];
  }, [form.data]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit.mutate({ publicId, data: values, submitToken: guard.submitToken, turnstileToken: guard.turnstileToken }, {
      onSuccess: (r: any) => {
        // Only an http(s) URL or an in-app path is followed — never a
        // javascript: URL (shared/safeRedirect.ts, audit 2026-10-20).
        const to = safeRedirectUrl(r?.redirectUrl);
        if (to) { window.location.href = to; return; }
        setDone(true);
      },
      // The message renders below the button; a Turnstile answer is single-use.
      onError: () => guard.reset(),
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
            <HoneypotField value={values[HONEYPOT_FIELD] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [HONEYPOT_FIELD]: v }))} />
            {guard.widget}
            {submit.error && <p className="text-xs text-rose-600">{submit.error.message}</p>}
            <Button type="submit" className="w-full" disabled={submit.isPending || guard.waiting}>
              {submit.isPending ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Submitting…</> : "Submit"}
            </Button>
            <p className="text-[10px] text-center text-muted-foreground">Powered by Velocity</p>
          </form>
        )}
      </div>
    </div>
  );
}
