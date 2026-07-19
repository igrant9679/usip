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
 * Articles are stored as markdown-ish plain text. Rather than pull in a
 * markdown dependency, render the subset the seeded content actually uses:
 * headings, bullets, numbered steps, fenced code and paragraphs. Anything
 * unrecognised falls through as a paragraph, so no content is ever hidden.
 */
function ArticleBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={blocks.length} className="text-sm leading-relaxed text-foreground/90">
        {para.join(" ")}
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
        {list.items.map((li, i) => <li key={i}>{li}</li>)}
      </Tag>,
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim().startsWith("```")) {
      if (code === null) { flushPara(); flushList(); code = []; }
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

    if (line.trim() === "") { flushPara(); flushList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const size = level <= 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm";
      blocks.push(
        <h2 key={blocks.length} className={`${size} font-semibold text-foreground mt-2`}>
          {heading[2]}
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
