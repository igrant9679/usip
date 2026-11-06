/**
 * AI Account Brief — a streamed, saved 300-word summary of one company.
 *
 * Moved out of RecordDrawer so the company profile can host it (audit
 * 2026-10-20, R47): the drawer's account view went with the retired v1
 * company pages, which left the brief reachable from nowhere.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Brain, Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { getActiveWorkspaceId } from "@/lib/activeWorkspace";

export function AccountBriefPanel({ accountId }: { accountId: number }) {
  const utils = trpc.useUtils();
  const { data: brief, isLoading } = trpc.accountBriefs.getLatest.useQuery({ accountId });
  const exportPdf = trpc.accountBriefs.exportPdf.useMutation({
    onSuccess: (data) => {
      window.open(data.url, "_blank");
      toast.success("PDF ready");
    },
    onError: (e) => toast.error(e.message),
  });

  // Streaming generation — replaces the trpc.accountBriefs.generate mutation.
  // Tokens fill `streamingContent` live; on completion the route saves to DB
  // and we invalidate the getLatest query so the saved row replaces the buffer.
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const handleGenerate = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStreamingContent("");
    setStreaming(true);

    const wsId = getActiveWorkspaceId();

    let accumulated = "";
    try {
      const res = await fetch(`/api/accounts/${accountId}/brief/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(wsId ? { "x-workspace-id": wsId } : {}),
        },
        credentials: "include",
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `Stream failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const rawLine = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (!rawLine.startsWith("data:")) continue;
          const data = rawLine.slice(5).trimStart();
          if (!data) continue;
          try {
            const ev = JSON.parse(data) as
              | { type: "delta"; text: string }
              | { type: "saved"; briefId: number }
              | { type: "done" }
              | { type: "error"; error: string };
            if (ev.type === "delta") {
              accumulated += ev.text;
              setStreamingContent(accumulated);
            } else if (ev.type === "saved") {
              // Server persisted the brief — refresh the query so the
              // streaming buffer is replaced by the canonical DB row.
              utils.accountBriefs.getLatest.invalidate({ accountId });
              toast.success("Account brief saved");
            } else if (ev.type === "error") {
              toast.error(ev.error);
            }
          } catch {
            // ignore malformed events / heartbeats
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        toast.error(err instanceof Error ? err.message : "Generation failed");
      }
    } finally {
      setStreaming(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="size-3 animate-spin" /> Loading…
      </div>
    );
  }

  // Show streaming buffer while in flight; show saved brief when idle.
  const showStreaming = streaming || (streamingContent && !brief);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">AI Account Brief</p>
          {brief && !streaming && (
            <p className="text-xs text-muted-foreground">
              Generated {new Date(brief.generatedAt).toLocaleDateString()}
            </p>
          )}
          {streaming && (
            <p className="text-xs text-muted-foreground">Generating…</p>
          )}
        </div>
        <div className="flex gap-2">
          {streaming && (
            <Button size="sm" variant="ghost" onClick={handleStop}>
              Stop
            </Button>
          )}
          {brief && !streaming && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => exportPdf.mutate({ briefId: brief.id })}
              disabled={exportPdf.isPending}
            >
              {exportPdf.isPending ? <Loader2 className="size-3 animate-spin mr-1" /> : <Download className="size-3 mr-1" />}
              PDF
            </Button>
          )}
          <Button size="sm" onClick={handleGenerate} disabled={streaming}>
            {streaming ? <Loader2 className="size-3 animate-spin mr-1" /> : <Brain className="size-3 mr-1" />}
            {brief ? "Regenerate" : "Generate Brief"}
          </Button>
        </div>
      </div>

      {!brief && !streaming && !streamingContent && (
        <div className="rounded-lg border bg-muted/30 p-6 text-center">
          <FileText className="size-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No brief generated yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Click "Generate Brief" to create an AI-powered 300-word executive account summary.
          </p>
        </div>
      )}

      {showStreaming && (
        <div className="rounded-lg border bg-card p-4">
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
            {streamingContent || (
              <span className="text-muted-foreground italic">Connecting…</span>
            )}
          </div>
        </div>
      )}

      {brief && !showStreaming && (
        <div className="rounded-lg border bg-card p-4">
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
            {brief.content}
          </div>
        </div>
      )}
    </div>
  );
}
