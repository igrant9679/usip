/**
 * AreMessageDialog — one dispatched campaign message, and everything it did.
 *
 * Opened from two places that both used to be dead ends (owner ask
 * 2026-08-14): a row in the Signals feed, and a card on Step performance. Each
 * described a message without ever letting you read it.
 *
 * Everything here comes from `are.execution.getMessage`, assembled server-side,
 * so the modal cannot show a different open count from the tab behind it.
 */
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProspectAvatar } from "@/components/usip/ProspectAvatar";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { isHtmlBody } from "@shared/emailBody";
import {
  signalMeta, describeSignal, actionLabel, signalSourceLabel,
} from "@shared/areSignals";
import {
  AtSign, Bot, ExternalLink, Eye, MailOpen, MousePointerClick, ServerCog, AlertTriangle,
} from "lucide-react";

function fmt(d?: string | Date | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtExact(d?: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
}

function Stat({ icon: Icon, label, value, hint, tone }: {
  icon: React.ElementType; label: string; value: string | number; hint?: string;
  tone?: "good" | "muted";
}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2" title={hint}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums mt-0.5 ${tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "muted" ? "text-muted-foreground" : ""}`}>
        {value}
      </div>
    </div>
  );
}

export function AreMessageDialog({
  executionQueueId,
  onClose,
}: {
  executionQueueId: number | null;
  onClose: () => void;
}) {
  const q = trpc.are.execution.getMessage.useQuery(
    { executionQueueId: executionQueueId ?? 0 },
    { enabled: !!executionQueueId, retry: false },
  );
  const m = q.data;

  const who = m ? `${m.recipient.firstName ?? ""} ${m.recipient.lastName ?? ""}`.trim() || m.recipient.email || "Unknown prospect" : "";
  const recordHref = m?.recipient.linkedContactId
    ? `/contacts/${m.recipient.linkedContactId}`
    : m?.recipient.personProspectId
      ? `/prospects/${m.recipient.personProspectId}`
      : null;

  const bodyIsHtml = !!m?.body && isHtmlBody(m.body);

  return (
    <Dialog open={!!executionQueueId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base pr-6 break-words">
            {q.isLoading ? "Loading message…" : (m?.subject || "(no subject)")}
          </DialogTitle>
        </DialogHeader>

        {q.error ? (
          <p className="text-sm text-muted-foreground">Couldn’t load this message. {q.error.message}</p>
        ) : q.isLoading || !m ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Who it went to, and from which inbox. */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProspectAvatar image={null} name={who} size="sm" className="!size-6 !text-[10px] shrink-0" />
                {recordHref ? (
                  <Link href={recordHref}>
                    <span className="text-sm font-medium hover:underline cursor-pointer">{who}</span>
                  </Link>
                ) : (
                  <span className="text-sm font-medium">{who}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {[m.recipient.title, m.recipient.companyName].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div className="grid gap-1 text-xs">
                <div className="grid grid-cols-[92px_1fr] gap-2">
                  <span className="text-muted-foreground">To</span>
                  <span className="break-all">{m.recipient.email ?? "—"}</span>
                </div>
                <div className="grid grid-cols-[92px_1fr] gap-2">
                  <span className="text-muted-foreground">{m.status === "sent" ? "Sent from" : "Will send from"}</span>
                  <span className="break-all">
                    {m.sentFrom.email ? (
                      <>
                        {m.sentFrom.email}
                        {m.sentFrom.name ? <span className="text-muted-foreground"> · {m.sentFrom.name}</span> : null}
                      </>
                    ) : m.sender ? (
                      // Not sent yet: the pool's pick as of now, through the
                      // send's own selection rule. The signature below is
                      // filled with this same name.
                      <>
                        {m.sender.email ?? "—"}
                        <span className="text-muted-foreground"> · {m.sender.name || "no display name"}</span>
                        <span className="text-muted-foreground italic" title="The pool picks the least-used eligible mailbox at send time; this is its pick right now.">
                          {" "}(pool’s current pick)
                        </span>
                      </>
                    ) : (
                      // The pool has always chosen an account per send; nothing
                      // stored it until migration 0166, and a pool of four
                      // mailboxes gives no way to work out which one a past
                      // send used. Saying so beats naming the wrong inbox.
                      <span className="text-muted-foreground italic" title="The sending mailbox was not recorded for sends dispatched before this was tracked.">
                        Not recorded for this send
                      </span>
                    )}
                  </span>
                </div>
                <div className="grid grid-cols-[92px_1fr] gap-2">
                  <span className="text-muted-foreground">Campaign</span>
                  <span>
                    <Link href={`/are/campaigns/${m.campaignId}`}>
                      <span className="hover:underline cursor-pointer">{m.campaignName ?? `Campaign #${m.campaignId}`}</span>
                    </Link>
                    <span className="text-muted-foreground"> · Step {(m.stepIndex ?? 0) + 1}</span>
                  </span>
                </div>
                <div className="grid grid-cols-[92px_1fr] gap-2">
                  <span className="text-muted-foreground">{m.status === "sent" ? "Sent" : "Scheduled"}</span>
                  <span title={fmtExact(m.executedAt ?? m.scheduledAt)}>{fmt(m.executedAt ?? m.scheduledAt)}</span>
                </div>
                {m.failureReason ? (
                  <div className="grid grid-cols-[92px_1fr] gap-2">
                    <span className="text-muted-foreground">Failure</span>
                    <span className="text-rose-600 dark:text-rose-400 inline-flex items-start gap-1">
                      <AlertTriangle className="size-3 mt-0.5 shrink-0" />{m.failureReason}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Stats. Human opens and machine fetches are shown apart — most
                pixel traffic is prefetch, and hiding that inflates the number
                every decision is made on. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat
                icon={MailOpen}
                label="Opens"
                value={m.opensTracked ? m.openCount : "—"}
                tone={m.openCount > 0 ? "good" : "muted"}
                hint={m.opensTracked
                  ? "Opens by a person. Machine prefetches are counted separately."
                  : "This send carries no tracking pixel, so an open can never be recorded for it."}
              />
              <Stat
                icon={ServerCog}
                label="Prefetches"
                value={m.opensTracked ? m.machineOpenCount : "—"}
                tone="muted"
                hint="Fetches by Apple Mail Privacy Protection, mail scanners and link previewers. Not people."
              />
              <Stat
                icon={Eye}
                label="First opened"
                value={m.openedAt ? fmt(m.openedAt) : "—"}
                tone="muted"
              />
              <Stat
                icon={MousePointerClick}
                label="Signals"
                value={m.signals.length}
                tone={m.signals.length > 0 ? "good" : "muted"}
                hint="Every signal this prospect produced, across the campaign."
              />
            </div>

            {/* The copy that actually went out. */}
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <AtSign className="size-3" /> The message
                {m.variantKey ? <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">Variant {m.variantKey}</Badge> : null}
              </div>
              {m.body ? (
                bodyIsHtml ? (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(m.body) }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed font-sans">{m.body}</pre>
                )
              ) : (
                <p className="text-xs text-muted-foreground">No body was stored for this message.</p>
              )}
            </div>

            {/* What came back. */}
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                What this prospect did
              </div>
              {m.signals.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing yet.</p>
              ) : (
                <div className="space-y-2">
                  {m.signals.map((s) => {
                    const meta = signalMeta(String(s.signalType));
                    const action = actionLabel(s.actionTaken);
                    const via = signalSourceLabel(s.rawPayload);
                    const details = describeSignal(String(s.signalType), s.rawPayload);
                    return (
                      <div key={s.id} className="rounded-md border bg-background/40 px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium">{meta.label}</span>
                          {s.sentiment ? (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 capitalize">{String(s.sentiment)}</Badge>
                          ) : null}
                          <span className="text-[10px] text-muted-foreground ml-auto" title={fmtExact(s.processedAt)}>
                            {fmt(s.processedAt)}
                          </span>
                        </div>
                        {details.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {details.slice(0, 4).map((d, i) => (
                              <div key={`${d.label}-${i}`} className="flex gap-2 text-[11px]">
                                <span className="shrink-0 text-muted-foreground w-[82px]">{d.label}</span>
                                {d.href ? (
                                  <a href={d.href} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all text-primary hover:underline">
                                    {d.value} <ExternalLink className="inline size-2.5 opacity-60" />
                                  </a>
                                ) : (
                                  <span className="min-w-0 break-words">{d.value}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {s.sentimentReason ? (
                          <div className="mt-1 text-[11px] text-muted-foreground">{s.sentimentReason}</div>
                        ) : null}
                        {action ? (
                          <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                            <Bot className="size-3" /> Velocity {action.charAt(0).toLowerCase() + action.slice(1)}
                          </div>
                        ) : null}
                        {via ? <div className="mt-0.5 text-[10px] text-muted-foreground/70">{via}</div> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
