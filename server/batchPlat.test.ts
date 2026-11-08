/**
 * Batch PLAT of the audit's final pass (2026-11-07): copy that matches what is
 * built (X6.4), per-page error states (G37, X1.6) and the pieces that are
 * pinned by reading the source rather than by running a procedure.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorBoundary from "../client/src/components/ErrorBoundary";

const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|md)$/.test(name)) out.push(rel);
  }
  return out;
}

/* ─── X6.4: copy that promises what is not built ─────────────────────────── */

describe("copy says what is built (X6.4)", () => {
  // Every screen, the help seeds the assistant reads, and the operator skill.
  const surfaces = [
    ...walk("client/src"),
    "server/seedHelpOperatorManual.ts", "server/seedHelpContent.ts", "server/productKnowledge.ts",
    ...(existsSync(join(ROOT, ".claude/skills/velocity-operator")) ? walk(".claude/skills/velocity-operator") : []),
  ];
  const text = surfaces.map((f) => [f, read(f)] as const);
  const offenders = (re: RegExp) => text.filter(([, s]) => re.test(s)).map(([f]) => f);

  it("no surface promises e-signature (another batch is building it; until then it is not claimed)", () => {
    expect(offenders(/\be-?sign(?:ature)?s?\b(?!ed)/i)).toEqual([]);
  });

  it("no surface promises renewal reminders (the renewal engine only recomputes a stage)", () => {
    expect(offenders(/renewal reminders?/i)).toEqual([]);
  });

  it("prompt templates do not claim the composer, research or the ICP agent read them", () => {
    expect(offenders(/used across the email composer/i)).toEqual([]);
    expect(read("client/src/pages/usip/PromptTemplates.tsx")).toContain("No AI feature reads them yet");
  });

  it("no page header calls a page real-time when it computes on load or on a sweep", () => {
    const headers = text.flatMap(([f, s]) => Array.from(s.matchAll(/<PageHeader[\s\S]*?description="([^"]*)"/g)).map((m) => [f, m[1]] as const));
    expect(headers.length).toBeGreaterThan(50);
    expect(headers.filter(([, d]) => /real[- ]?time/i.test(d)).map(([f]) => f)).toEqual([]);
  });

  it("Connected accounts says LinkedIn connection changes are not instant", () => {
    expect(read("client/src/pages/usip/ConnectedAccounts.tsx")).toContain("LinkedIn connection changes can take a few hours to show.");
  });
});

/* ─── G37: a page's own crash keeps the sidebar ──────────────────────────── */

describe("a crash in a page's own body renders that page's error, inside the shell (G37)", () => {
  const boom = Object.assign(new Error("Cannot read properties of undefined (reading 'id')"), { stack: "Error: at LeadDetail (LeadDetail.tsx:40)" });
  const crashed = (props: Record<string, unknown>) => {
    const b = new ErrorBoundary({ children: null, ...props } as any);
    b.state = { hasError: true, error: boom };
    return renderToStaticMarkup(b.render() as ReactElement);
  };

  it("the boundary can put its error state inside something (the Shell)", () => {
    const wrap = (content: unknown) => createElement("div", { id: "shell" }, content as any);
    const out = crashed({ inline: true, resetKey: "/leads/7", wrap });
    expect(out.startsWith('<div id="shell"><div role="alert"')).toBe(true);
    expect(out).toContain("This page hit a problem");
    expect(out).toContain("Go back");
  });

  it("without wrap it renders as before", () => {
    expect(crashed({ inline: true }).startsWith('<div role="alert"')).toBe(true);
  });

  it("every signed-in page gets its own boundary, inside the route boundary, that shows the error in a Shell", () => {
    const app = read("client/src/App.tsx");
    const gate = app.slice(app.indexOf("function AuthGate("), app.indexOf("function PageLoading("));
    expect(gate).toContain("<WorkspaceAccessGate><PageBoundary>{children}</PageBoundary></WorkspaceAccessGate>");
    const boundary = gate.slice(gate.indexOf("function PageBoundary("));
    expect(boundary).toContain("const [path] = useLocation();");
    expect(boundary).toContain("<ErrorBoundary resetKey={path} inline wrap={(content) => <Suspense fallback={content}><LazyShell>{content}</LazyShell></Suspense>}>");
    // The Shell for an error state is lazy, so the entry bundle does not grow.
    expect(app).toContain('const LazyShell = lazyChunk(() => import("@/components/usip/Shell").then((m) => ({ default: m.Shell })));');
    expect(app).not.toMatch(/^import \{[^}]*\bShell\b[^}]*\} from "@\/components\/usip\/Shell";/m);
  });
});

/* ─── X1.6: every page with a query has an error branch ──────────────────── */

/**
 * A page that reads data must say when the read failed (audit X1.6): a failed
 * load rendered as an empty state reads as "there is nothing", and one with no
 * branch at all spins or shows zeros. An error branch is one of: QueryError,
 * QueryState, FailedLoadsBanner, NotFoundState, isError, or a test of a
 * query's `.error`.
 */
const ERROR_BRANCH = /<QueryError\b|<QueryState\b|<FailedLoadsBanner\b|<NotFoundState\b|\bisError\b|[A-Za-z_\])]\.error\s*(\?|&&|\)|\|\||!|;|,)|\berror\s*(\?\s|&&)|\{[^}]*\berror\b[^}]*\}\s*=\s*trpc\./;

/** Pages in areas other batches had in flight on 2026-11-07, left for the merge. */
const LEFT_FOR_MERGE: Record<string, string> = {
  "client/src/pages/usip/AREHub.tsx": "Revenue Engine (batch ARES)",
  "client/src/pages/usip/AREIcpAgent.tsx": "Revenue Engine (batch ARES)",
  "client/src/pages/usip/CompanyProfile.tsx": "companies (batch CRMP)",
  "client/src/pages/usip/ProspectDetail.tsx": "People (batch CRMP)",
  "client/src/pages/usip/Pipeline.tsx": "the opportunities board (batch CRMP)",
  "client/src/pages/usip/ImportContacts.tsx": "import (batch CRMP)",
};

describe("every page that reads data says when the read failed (X1.6)", () => {
  const pages = walk("client/src/pages").filter((f) => f.endsWith(".tsx")).map((f) => [f, read(f)] as const);
  const missing = pages.filter(([, s]) => /\.useQuery\(/.test(s) && !ERROR_BRANCH.test(s)).map(([f]) => f);

  it("no page has a query and no error branch", () => {
    expect(missing.filter((f) => !(f in LEFT_FOR_MERGE))).toEqual([]);
  });

  it("each page left for the merge still needs it (drop the entry once it has one)", () => {
    for (const f of Object.keys(LEFT_FOR_MERGE)) expect(missing, f).toContain(f);
  });

  it("the guard tells a branch from a toast", () => {
    expect(ERROR_BRANCH.test("onError: (e) => toast.error(e.message)")).toBe(false);
    expect(ERROR_BRANCH.test("if (q.error && !q.data) return null;")).toBe(true);
    expect(ERROR_BRANCH.test("<FailedLoadsBanner />")).toBe(true);
  });

  it("the audit's seven pages each have theirs", () => {
    expect(read("client/src/pages/usip/Dashboard.tsx")).toContain("<FailedLoadsBanner />");
    expect(read("client/src/pages/usip/EmailAnalytics.tsx")).toContain("<FailedLoadsBanner />");
    const deliv = read("client/src/pages/usip/Deliverability.tsx");
    expect(deliv).toContain('accountsQ.error && !accountsQ.data ? (\n                <QueryError what="sending accounts"');
    expect(deliv.indexOf("accountsQ.error && !accountsQ.data")).toBeLessThan(deliv.indexOf("No sending accounts connected"));
    const forecast = read("client/src/pages/usip/Forecast.tsx");
    expect(forecast).toContain('byRepError && !byRep ? <QueryError what="the forecast"');
    expect(forecast.indexOf("byRepError && !byRep")).toBeLessThan(forecast.indexOf("No pipeline data yet"));
    expect(read("client/src/pages/usip/Inbox.tsx")).toContain('<QueryError what="notifications" message={error?.message} onRetry=');
    const lead = read("client/src/pages/usip/LeadDetail.tsx");
    expect(lead).toContain('if (error && !lead && !isNotFoundError(error)) return <Shell title="Lead"><QueryError what="this lead"');
    expect(lead.indexOf("if (error && !lead")).toBeLessThan(lead.indexOf("if (!lead) return"));
    expect(read("client/src/pages/usip/Library.tsx")).toContain('{me.error && !me.data && (\n          <QueryError compact what="your role"');
  });

  it("an editor whose load failed does not open blank (its next save would overwrite)", () => {
    const mind = read("client/src/pages/usip/MindmapCanvas.tsx");
    const at = mind.indexOf("if (canvasQuery.error && !canvasData)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(mind.indexOf('const mapName = canvasData?.map?.name ?? "Mindmap";'));
    expect(read("client/src/pages/usip/SequenceCanvas.tsx")).toContain("if (canvasQ.error && !canvasQ.data) {");
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain('if (me.error && !me.data) {\n    return <div className="px-4 sm:px-6 pt-4"><QueryError what="your profile"');
  });
});
