import { Link } from "wouter";

export type CitedArticle = { id: number; slug: string; title: string };

/**
 * The articles an Ask AI answer drew on, by title and linked (G71). It printed
 * "Sources: Article 12, 34", ids nobody could open.
 */
export function CitedArticles({ articles, className }: { articles?: CitedArticle[]; className?: string }) {
  if (!articles?.length) return null;
  return (
    <p className={className}>
      Sources:{" "}
      {articles.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <Link href={`/help/articles/${a.slug}`} className="underline underline-offset-2 hover:opacity-100">{a.title}</Link>
        </span>
      ))}
    </p>
  );
}
