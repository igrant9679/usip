/**
 * HelpArticle — a single knowledge-base article at /help/articles/:slug
 *
 * The Help Center's article cards have always linked here, but no route was
 * ever registered — so every card on a 39-article knowledge base fell through
 * to NotFound. The primary call-to-action of the entire Help Center was dead.
 *
 * Everything this needs already existed server-side: helpCenter.getArticle
 * (which also bumps viewCount) and helpCenter.submitFeedback.
 */
import { Button } from "@/components/ui/button";
import { PageHeader, QueryError, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, BookOpen, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";

/**
 * Inline markdown: **bold**, *italic*, `code`, and [text](href). Kept as a
 * tiny hand-rolled tokenizer for the same reason the block renderer is: the
 * seeded articles use exactly this subset and nothing else, and a dependency
 * would be the only one in the client for a page that ships text. Internal
 * hrefs (leading slash) become client-side Links so an article can point at
 * another article or at a page without a full reload; anything else opens in
 * a new tab. Unmatched markers fall through as literal text — never hidden.
 */
export function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*([^*\s][^*]*)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={k++} className="font-semibold text-foreground">{m[2]}</strong>);
    else if (m[3]) out.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{m[4]}</code>);
    else if (m[5]) {
      const href = m[7];
      out.push(
        href.startsWith("/")
          ? <Link key={k++} href={href} className="text-primary underline underline-offset-2">{m[6]}</Link>
          : <a key={k++} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{m[6]}</a>,
      );
    } else if (m[8]) out.push(<em key={k++}>{m[9]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A markdown pipe-table row → its cells (outer pipes optional). */
export function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}
export function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Articles are stored as markdown-ish plain text. Rather than pull in a
 * markdown dependency, render the subset the seeded content actually uses:
 * headings, bullets, numbered steps, fenced code, pipe tables, paragraphs,
 * and the inline set above. Anything unrecognised falls through as a
 * paragraph, so no content is ever hidden.
 */
function ArticleBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={blocks.length} className="text-sm leading-relaxed text-foreground/90">
        {renderInline(para.join(" "))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={blocks.length}
        className={`${list.ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1 text-sm text-foreground/90`}
      >
        {list.items.map((li, i) => <li key={i}>{renderInline(li)}</li>)}
      </Tag>,
    );
    list = null;
  };
  const flushTable = () => {
    if (!table || table.length === 0) { table = null; return; }
    const [head, ...rows] = table;
    blocks.push(
      <div key={blocks.length} className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60">
            <tr>{head.map((c, i) => <th key={i} className="px-3 py-2 text-left font-semibold text-foreground">{renderInline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-t border-border align-top">
                {head.map((_, ci) => <td key={ci} className="px-3 py-2 text-foreground/90">{renderInline(r[ci] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim().startsWith("```")) {
      if (code === null) { flushPara(); flushList(); flushTable(); code = []; }
      else {
        blocks.push(
          <pre key={blocks.length} className="rounded-lg bg-muted p-3 text-xs overflow-x-auto">
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }

    if (line.trim().startsWith("|")) {
      flushPara(); flushList();
      if (isTableSeparator(line)) continue;
      if (!table) table = [];
      table.push(splitTableRow(line));
      continue;
    }
    flushTable();

    if (line.trim() === "") { flushPara(); flushList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const size = level <= 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm";
      blocks.push(
        <h2 key={blocks.length} className={`${size} font-semibold text-foreground mt-2`}>
          {renderInline(heading[2])}
        </h2>,
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  flushTable();
  if (code !== null && code.length > 0) {
    // Unterminated fence — show it rather than swallow the rest of the article.
    blocks.push(
      <pre key={blocks.length} className="rounded-lg bg-muted p-3 text-xs overflow-x-auto">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }
  return <div className="space-y-3">{blocks}</div>;
}

export default function HelpArticle() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const { data: article, isLoading, error, refetch } = trpc.helpCenter.getArticle.useQuery(
    { slug },
    { enabled: slug.length > 0 },
  );

  const [voted, setVoted] = useState<boolean | null>(null);
  const feedback = trpc.helpCenter.submitFeedback.useMutation({
    onSuccess: () => toast.success("Thanks — that helps us improve these docs."),
    onError: (e: any) => toast.error(e?.message ?? "Could not record feedback"),
  });

  return (
    <Shell title={article?.title ?? "Help"}>
      <PageHeader
        title={article?.title ?? "Help article"}
        description={article?.summary ?? undefined}
        icon={<BookOpen className="size-5" />}
      >
        <Link href="/help">
          <Button variant="outline" size="sm" className="gap-1.5">
            <ArrowLeft className="size-3.5" /> Help Center
          </Button>
        </Link>
      </PageHeader>

      <div className="p-4 max-w-3xl">
        {error ? (
          <QueryError
            message={
              (error as any)?.data?.code === "NOT_FOUND"
                ? "That article doesn't exist (it may have been renamed)."
                : error.message
            }
            onRetry={() => refetch()}
          />
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading article…
          </div>
        ) : article ? (
          <article className="rounded-xl border bg-card p-5 space-y-4">
            {article.readingTimeMinutes ? (
              <div className="text-xs text-muted-foreground">{article.readingTimeMinutes} min read</div>
            ) : null}

            <ArticleBody text={String(article.bodyMarkdown ?? article.summary ?? "")} />

            <div className="border-t pt-4 flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Was this helpful?</span>
              <Button
                size="sm"
                variant={voted === true ? "default" : "outline"}
                className="gap-1.5"
                disabled={feedback.isPending || voted !== null}
                onClick={() => { setVoted(true); feedback.mutate({ articleId: article.id, helpful: true }); }}
              >
                <ThumbsUp className="size-3.5" /> Yes
              </Button>
              <Button
                size="sm"
                variant={voted === false ? "default" : "outline"}
                className="gap-1.5"
                disabled={feedback.isPending || voted !== null}
                onClick={() => { setVoted(false); feedback.mutate({ articleId: article.id, helpful: false }); }}
              >
                <ThumbsDown className="size-3.5" /> No
              </Button>
            </div>
          </article>
        ) : null}
      </div>
    </Shell>
  );
}
