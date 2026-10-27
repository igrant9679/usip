import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

/**
 * What broke, said plainly (audit 2026-10-20, Phase 4, G37).
 *
 * It printed the raw stack trace as the whole screen, and there was one
 * boundary for the app, so a single broken widget took navigation down with
 * it. App.tsx now puts one around the routes, keyed by the path: leaving the
 * page clears it. The stack is still there, folded, for a support message.
 */
interface Props {
  children: ReactNode;
  /** When this changes, the boundary forgets the error (the route's path). */
  resetKey?: string;
  /** Inside the app shell: no full-screen takeover, and a way back. */
  inline?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** A chunk from the previous deploy that the reload in lib/lazyChunk.ts could not fix. */
export function isStaleChunkError(error: Error | null): boolean {
  return !!error && /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(error.message);
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      const stale = isStaleChunkError(this.state.error);
      return (
        <div role="alert" className={cn("flex items-center justify-center p-8 bg-background", this.props.inline ? "min-h-[60vh]" : "min-h-screen")}>
          <div className="flex flex-col items-center w-full max-w-xl p-8 text-center">
            <AlertTriangle size={40} className="text-destructive mb-5 flex-shrink-0" aria-hidden="true" />
            <h1 className="text-xl font-semibold mb-2">
              {stale ? "A new version of Velocity is available" : "This page hit a problem"}
            </h1>
            <p className="text-sm text-muted-foreground mb-6">
              {stale
                ? "Reload to get it. Nothing you saved is lost."
                : "Nothing you saved is lost. Reload to try again; if it keeps happening, send us the details below."}
            </p>
            <div className="flex items-center gap-2 mb-6">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 cursor-pointer"
              >
                <RotateCcw size={16} aria-hidden="true" />
                Reload page
              </button>
              {this.props.inline && (
                <button
                  type="button"
                  onClick={() => window.history.back()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border hover:bg-muted cursor-pointer"
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  Go back
                </button>
              )}
            </div>
            {!stale && this.state.error && (
              <details className="w-full text-left">
                <summary className="text-xs text-muted-foreground cursor-pointer">Details</summary>
                <pre className="mt-2 p-3 rounded bg-muted text-xs text-muted-foreground whitespace-break-spaces overflow-auto max-h-64">
                  {this.state.error.message}
                  {"\n\n"}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
