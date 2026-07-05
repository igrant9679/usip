/**
 * LandingPage — hosted, unauthenticated marketing page at /l/:slug.
 *
 * Renders an Admin-authored page (hero + text sections) with a lead-capture
 * form that posts to the public landingPages.submit mutation, which autonomously
 * creates + routes + enrolls a lead. No Shell, no auth — standalone page.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Loader2, CalendarCheck } from "lucide-react";

type Field = { key: string; label: string; required?: boolean };

export default function LandingPage() {
  const [, params] = useRoute("/l/:slug");
  const slug = params?.slug ?? "";

  const page = trpc.landingPages.getBySlug.useQuery({ slug }, { enabled: !!slug, retry: false });
  const submit = trpc.landingPages.submit.useMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const accent = page.data?.themeColor || "#14B89A";
  const fields: Field[] = useMemo(() => {
    const f = page.data?.formFields;
    return Array.isArray(f) && f.length ? (f as Field[]) : [];
  }, [page.data]);
  const sections = useMemo(() => {
    const s = page.data?.sections;
    return Array.isArray(s) ? (s as Array<{ heading: string; body: string }>) : [];
  }, [page.data]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit.mutate({ slug, data: values }, {
      onSuccess: (r: any) => {
        if (r?.redirectUrl) { window.location.href = r.redirectUrl; return; }
        setDone(true);
      },
    });
  };

  const inputType = (key: string) => (key === "email" ? "email" : key === "phone" ? "tel" : "text");

  if (page.isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>;
  }
  if (!page.data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <div className="text-base font-semibold">Page not available</div>
          <p className="text-sm text-muted-foreground mt-1">This page may be unpublished or removed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      {/* Hero */}
      <header className="relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${accent}14 0%, #ffffff 60%)` }}>
        <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
        <div className="max-w-3xl mx-auto px-6 pt-16 pb-10 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{page.data.headline}</h1>
          {page.data.subheadline && <p className="text-lg text-slate-600 mt-4">{page.data.subheadline}</p>}
          {page.data.bookingUrl && (
            <div className="mt-6">
              <a href={page.data.bookingUrl} className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-white text-sm font-semibold shadow-sm" style={{ backgroundColor: accent }}>
                <CalendarCheck className="size-4" /> Book a meeting
              </a>
            </div>
          )}
        </div>
        {page.data.heroImageUrl && (
          <div className="max-w-3xl mx-auto px-6 pb-4">
            <img src={page.data.heroImageUrl} alt="" className="w-full max-h-80 object-cover rounded-2xl shadow-sm" />
          </div>
        )}
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 grid md:grid-cols-5 gap-10">
        {/* Content sections */}
        <div className="md:col-span-3 space-y-6">
          {sections.length === 0 ? (
            <p className="text-slate-500 text-sm">&nbsp;</p>
          ) : sections.map((s, i) => (
            <section key={i}>
              {s.heading && <h2 className="text-xl font-semibold tracking-tight mb-2">{s.heading}</h2>}
              {s.body && <div className="text-slate-600 whitespace-pre-wrap leading-relaxed">{s.body}</div>}
            </section>
          ))}
        </div>

        {/* Lead form */}
        <div className="md:col-span-2">
          <div className="rounded-2xl border border-slate-200 shadow-sm p-5 sticky top-6">
            {done ? (
              <div className="text-center py-8">
                <CheckCircle2 className="size-10 mx-auto mb-3" style={{ color: accent }} />
                <div className="text-base font-semibold">Thank you!</div>
                <p className="text-sm text-slate-500 mt-1">We've received your details and will be in touch shortly.</p>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3">
                <h3 className="text-base font-semibold">{page.data.formHeading}</h3>
                {fields.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`lp-${f.key}`} className="text-slate-700">{f.label}{f.required ? " *" : ""}</Label>
                    {f.key === "message" ? (
                      <Textarea id={`lp-${f.key}`} rows={3} required={f.required}
                        value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                    ) : (
                      <Input id={`lp-${f.key}`} type={inputType(f.key)} required={f.required}
                        value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                    )}
                  </div>
                ))}
                {submit.error && <p className="text-xs text-rose-600">{submit.error.message}</p>}
                <Button type="submit" className="w-full text-white" style={{ backgroundColor: accent }} disabled={submit.isPending}>
                  {submit.isPending ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Submitting…</> : page.data.ctaButtonLabel}
                </Button>
              </form>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-100 py-6 text-center text-[11px] text-slate-400">Powered by Velocity</footer>
    </div>
  );
}
