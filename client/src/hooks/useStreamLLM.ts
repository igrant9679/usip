/**
 * Client hook for the /api/llm/stream SSE endpoint.
 *
 * Usage:
 *   const { stream, text, isStreaming, error, abort, reset } = useStreamLLM();
 *   stream({ messages: [{ role: "user", content: "Write a haiku" }] });
 *
 * The hook owns the accumulator state and an AbortController so the consumer
 * doesn't have to. `abort()` cancels the in-flight request; `reset()` clears
 * the accumulated text and error.
 */
import { useCallback, useRef, useState } from "react";

export type StreamMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type StreamLLMParams = {
  messages: StreamMessage[];
  provider?: "anthropic" | "openai" | "gemini";
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

type Options = {
  onDelta?: (delta: string) => void;
  onDone?: (full: string) => void;
  onError?: (message: string) => void;
};

export function useStreamLLM(options?: Options) {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setText("");
    setError(null);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const stream = useCallback(
    async (params: StreamLLMParams): Promise<string> => {
      // Cancel any in-flight stream first.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setText("");
      setError(null);
      setIsStreaming(true);

      let accumulated = "";

      const wsId =
        typeof window !== "undefined"
          ? window.localStorage.getItem("usip:workspaceId")
          : null;

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        if (wsId) headers["x-workspace-id"] = wsId;

        const res = await fetch("/api/llm/stream", {
          method: "POST",
          headers,
          credentials: "include",
          body: JSON.stringify(params),
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
              const ev = JSON.parse(data) as StreamEvent;
              if (ev.type === "delta") {
                accumulated += ev.text;
                setText(accumulated);
                options?.onDelta?.(ev.text);
              } else if (ev.type === "error") {
                setError(ev.error);
                options?.onError?.(ev.error);
              }
              // "done" requires no action — the loop terminates when the
              // server closes the connection (reader returns done=true).
            } catch {
              // Ignore malformed events (heartbeats etc.)
            }
          }
        }

        options?.onDone?.(accumulated);
        return accumulated;
      } catch (err) {
        if (controller.signal.aborted) return accumulated;
        const message = err instanceof Error ? err.message : "Stream failed";
        setError(message);
        options?.onError?.(message);
        return accumulated;
      } finally {
        setIsStreaming(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [options],
  );

  return { stream, text, isStreaming, error, abort, reset };
}
