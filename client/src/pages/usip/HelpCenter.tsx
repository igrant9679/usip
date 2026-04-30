/**
 * Help Center — full-page knowledge base
 *
 * Tabs:
 *  1. Browse — category grid + article list with search
 *  2. Ask AI — full-width conversational AI helper
 *  3. Guided Tours — all tours with progress indicators
 *  4. Admin (admin-only) — article authoring + category management + insights
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { useTourEngine } from "@/components/usip/TourEngine";
import { trpc } from "@/lib/trpc";
import {
  BookOpen,
  Bot,
  ChevronRight,
  Edit,
  GraduationCap,
  Layers,
  Loader2,
  Plus,
  Search,
  Settings,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/* ─── Types ──────────────────────────────────────────────────────────────── */

type Tab = "browse" | "ask" | "tours" | "admin";

/* ─── Browse Tab ─────────────────────────────────────────────────────────── */

function BrowseTab() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  const { data: categories } = trpc.helpCenter.listCategories.useQuery();
  const { data: articles, isFetching } = trpc.helpCenter.searchArticles.useQuery(
    { query: debouncedQuery, categoryId: selectedCategory ?? undefined, limit: 20 },
  );
  const { data: allArticles } = trpc.helpCenter.listArticles.useQuery(
    { status: "published", categoryId: selectedCategory ?? undefined, limit: 20 },
    { enabled: debouncedQuery.length < 2 },
  );

  const displayArticles = debouncedQuery.length >= 2 ? articles : allArticles;

  const logClick = trpc.helpCenter.logSearchClick.useMutation();

  return (
    <div className="flex flex-col gap-6">
      {/* Search bar */}
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all articles…"
          className="pl-9 pr-8"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-violet-400" />
        )}
      </div>

      {/* Category chips */}
      {categories && categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              selectedCategory === null
                ? "bg-violet-600 text-white border-violet-600"
                : "bg-white text-gray-600 border-gray-200 hover:border-violet-300"
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                selectedCategory === cat.id
                  ? "bg-violet-600 text-white border-violet-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-violet-300"
              }`}
            >
              {cat.icon && <span className="mr-1">{cat.icon}</span>}
              {cat.name}
            </button>
          ))}
        </div>
      )}

      {/* Article grid */}
      {displayArticles && displayArticles.length === 0 && (
        <EmptyState
          icon={<BookOpen className="h-8 w-8 text-gray-300" />}
          title="No articles found"
          description="Try a different search term or category"
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {displayArticles?.map((article) => (
          <a
            key={article.id}
            href={`/help/articles/${article.slug}`}
            onClick={() => {
              if (debouncedQuery) logClick.mutate({ query: debouncedQuery, articleId: article.id });
            }}
            className="block rounded-xl border border-gray-200 bg-white p-4 hover:border-violet-300 hover:shadow-sm transition-all group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 group-hover:text-violet-700 line-clamp-2">
                  {article.title}
                </p>
                {article.summary && (
                  <p className="text-xs text-gray-500 mt-1 line-clamp-3">{article.summary}</p>
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-violet-400 flex-shrink-0 mt-0.5" />
            </div>
            <div className="flex items-center gap-2 mt-3">
              {article.readingTimeMinutes && (
                <span className="text-xs text-gray-400">{article.readingTimeMinutes} min read</span>
              )}
              {article.helpfulYes !== undefined && (article.helpfulYes + article.helpfulNo) > 0 && (
                <span className="text-xs text-gray-400">
                  👍 {Math.round((article.helpfulYes / (article.helpfulYes + article.helpfulNo)) * 100)}%
                </span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

/* ─── Ask AI Tab (full page) ─────────────────────────────────────────────── */

type Message = { role: "user" | "assistant"; body: string; citedArticleIds?: number[] };

function AskAITab() {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const startConv = trpc.helpCenter.startConversation.useMutation();
  const askAI = trpc.helpCenter.askAI.useMutation();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || isLoading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", body: userMsg }]);
    setIsLoading(true);
    try {
      let convId = conversationId;
      if (!convId) {
        const res = await startConv.mutateAsync();
        convId = res.conversationId;
        setConversationId(convId);
      }
      const res = await askAI.mutateAsync({ conversationId: convId, message: userMsg });
      setMessages((m) => [
        ...m,
        { role: "assistant", body: res.answer, citedArticleIds: res.citedArticleIds },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", body: "Sorry, I couldn't process that. Please try again." },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-220px)] max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto flex flex-col gap-4 pb-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-violet-100 flex items-center justify-center mx-auto mb-4">
              <Bot className="h-8 w-8 text-violet-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-800">Ask me anything</h3>
            <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
              I have full knowledge of the platform. Ask about features, workflows, or how to accomplish specific tasks.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-4">
              {[
                "How do I create a sequence?",
                "What is the ARE Hub?",
                "How does lead scoring work?",
                "How do I set up email integration?",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="px-3 py-1.5 text-xs text-violet-600 border border-violet-200 rounded-full hover:bg-violet-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                msg.role === "user"
                  ? "bg-violet-600 text-white"
                  : "bg-white border border-gray-200 text-gray-800 shadow-sm"
              }`}
            >
              <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
              {msg.citedArticleIds && msg.citedArticleIds.length > 0 && (
                <p className="text-xs mt-2 opacity-60">
                  📖 Sources: Article {msg.citedArticleIds.join(", ")}
                </p>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
              <div className="flex gap-1 items-center">
                <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
                <span className="text-xs text-gray-400 ml-1">Thinking…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 pt-3 border-t border-gray-100">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="Ask a question about the platform…"
          disabled={isLoading}
          className="flex-1"
        />
        <Button
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
          className="bg-violet-600 hover:bg-violet-700 text-white"
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/* ─── Guided Tours Tab ───────────────────────────────────────────────────── */

/** Fetches the full tour (with steps) then hands it to the TourEngine. */
function TourStartButton({ tourId, label }: { tourId: number; label: string }) {
  const { startTour } = useTourEngine();
  const utils = trpc.useUtils();
  const [loading, setLoading] = useState(false);
  const handleStart = useCallback(async () => {
    setLoading(true);
    try {
      const full = await utils.tours.get.fetch({ id: tourId });
      startTour(full);
    } catch {
      // fall back silently
    } finally {
      setLoading(false);
    }
  }, [tourId, startTour, utils]);
  return (
    <Button
      size="sm"
      variant="outline"
      className="text-violet-600 border-violet-200 hover:bg-violet-50 h-7 text-xs"
      onClick={handleStart}
      disabled={loading}
    >
      {loading ? "Loading…" : label}
    </Button>
  );
}

function ToursTab() {
  const { data: allTours } = trpc.tours.list.useQuery({ type: "all", status: "published" });
  const { data: myProgress } = trpc.tours.getMyProgress.useQuery();

  const progressMap = Object.fromEntries((myProgress ?? []).map((p) => [p.tourId, p]));

  const typeLabel: Record<string, string> = {
    onboarding: "🎓 Onboarding",
    feature: "⭐ Feature",
    whats_new: "🆕 What's New",
    custom: "🏆 Custom",
  };

  const grouped = (allTours ?? []).reduce<Record<string, typeof allTours>>((acc, tour) => {
    const key = tour.type ?? "custom";
    if (!acc[key]) acc[key] = [];
    acc[key]!.push(tour);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-8">
      {Object.entries(grouped).map(([type, tours]) => (
        <div key={type}>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            {typeLabel[type] ?? type}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tours?.map((tour) => {
              const prog = progressMap[tour.id];
              const isCompleted = prog?.status === "completed";
              const isInProgress = prog?.status === "in_progress";
              return (
                <div
                  key={tour.id}
                  className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800 line-clamp-1">{tour.name}</p>
                      {tour.description && (
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{tour.description}</p>
                      )}
                    </div>
                    {isCompleted && (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full flex-shrink-0">✓ Done</span>
                    )}
                    {isInProgress && (
                      <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full flex-shrink-0">In progress</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    {tour.estimatedMinutes ? (
                      <span className="text-xs text-gray-400">~{tour.estimatedMinutes} min</span>
                    ) : (
                      <span />
                    )}
                    <TourStartButton
                      tourId={tour.id}
                      label={isCompleted ? "Replay" : isInProgress ? "Resume" : "Start"}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {(!allTours || allTours.length === 0) && (
        <EmptyState
          icon={<GraduationCap className="h-8 w-8 text-gray-300" />}
          title="No tours yet"
          description="Admins can create guided tours in the Admin tab"
        />
      )}
    </div>
  );
}

/* ─── Admin Tab ──────────────────────────────────────────────────────────── */

function AdminTab() {
  const [view, setView] = useState<"articles" | "categories" | "insights">("articles");
  const [editArticle, setEditArticle] = useState<any | null>(null);
  const [isNew, setIsNew] = useState(false);

  const { data: articles, refetch } = trpc.helpCenter.listArticles.useQuery({ limit: 50 });
  const { data: categories } = trpc.helpCenter.listCategories.useQuery();
  const { data: insights } = trpc.helpCenter.getInsights.useQuery();

  const createMut = trpc.helpCenter.createArticle.useMutation({
    onSuccess: () => { toast.success("Article created"); refetch(); setEditArticle(null); setIsNew(false); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.helpCenter.updateArticle.useMutation({
    onSuccess: () => { toast.success("Article updated"); refetch(); setEditArticle(null); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.helpCenter.deleteArticle.useMutation({
    onSuccess: () => { toast.success("Article deleted"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  function ArticleForm() {
    const [form, setForm] = useState({
      title: editArticle?.title ?? "",
      slug: editArticle?.slug ?? "",
      summary: editArticle?.summary ?? "",
      bodyMarkdown: editArticle?.bodyMarkdown ?? "",
      categoryId: editArticle?.categoryId?.toString() ?? "",
      status: editArticle?.status ?? "draft",
      pageKeys: editArticle?.pageKeys ?? [],
      readingTimeMinutes: editArticle?.readingTimeMinutes?.toString() ?? "",
    });

    function save() {
      const payload = {
        title: form.title,
        slug: form.slug || form.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
        summary: form.summary || undefined,
        bodyMarkdown: form.bodyMarkdown,
        categoryId: form.categoryId ? parseInt(form.categoryId) : undefined,
        status: form.status as "draft" | "published" | "archived",
        pageKeys: form.pageKeys,
        readingTimeMinutes: form.readingTimeMinutes ? parseInt(form.readingTimeMinutes) : undefined,
      };
      if (isNew) {
        createMut.mutate(payload);
      } else {
        updateMut.mutate({ id: editArticle.id, ...payload });
      }
    }

    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Article title" />
          </div>
          <div>
            <Label>Slug</Label>
            <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="auto-generated-from-title" />
          </div>
        </div>
        <div>
          <Label>Summary</Label>
          <Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="One-line description shown in search results" />
        </div>
        <div>
          <Label>Body (Markdown)</Label>
          <Textarea
            value={form.bodyMarkdown}
            onChange={(e) => setForm({ ...form, bodyMarkdown: e.target.value })}
            rows={12}
            placeholder="Write article content in Markdown…"
            className="font-mono text-xs"
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label>Category</Label>
            <Select value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v })}>
              <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {categories?.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reading time (min)</Label>
            <Input
              type="number"
              value={form.readingTimeMinutes}
              onChange={(e) => setForm({ ...form, readingTimeMinutes: e.target.value })}
              placeholder="5"
            />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => { setEditArticle(null); setIsNew(false); }}>Cancel</Button>
          <Button
            className="bg-violet-600 hover:bg-violet-700 text-white"
            onClick={save}
            disabled={createMut.isPending || updateMut.isPending}
          >
            {(createMut.isPending || updateMut.isPending) && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            {isNew ? "Create Article" : "Save Changes"}
          </Button>
        </div>
      </div>
    );
  }

  if (editArticle !== null || isNew) {
    return (
      <div>
        <button
          onClick={() => { setEditArticle(null); setIsNew(false); }}
          className="text-xs text-violet-500 hover:text-violet-700 mb-4 flex items-center gap-1"
        >
          ← Back to articles
        </button>
        <h3 className="text-sm font-semibold text-gray-800 mb-4">
          {isNew ? "New Article" : `Edit: ${editArticle.title}`}
        </h3>
        <ArticleForm />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-nav */}
      <div className="flex gap-1 border-b border-gray-100 pb-1">
        {(["articles", "categories", "insights"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
              view === v ? "bg-violet-100 text-violet-700" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {v}
          </button>
        ))}
        <div className="ml-auto">
          <Button
            size="sm"
            className="bg-violet-600 hover:bg-violet-700 text-white h-7 text-xs"
            onClick={() => { setIsNew(true); setEditArticle(null); }}
          >
            <Plus className="h-3 w-3 mr-1" /> New Article
          </Button>
        </div>
      </div>

      {/* Articles list */}
      {view === "articles" && (
        <div className="flex flex-col gap-1">
          {articles?.map((article) => (
            <div
              key={article.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-white hover:border-violet-100"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 line-clamp-1">{article.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    article.status === "published" ? "bg-green-100 text-green-700" :
                    article.status === "draft" ? "bg-amber-100 text-amber-700" :
                    "bg-gray-100 text-gray-500"
                  }`}>
                    {article.status}
                  </span>
                  {article.viewCount !== undefined && (
                    <span className="text-xs text-gray-400">{article.viewCount} views</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-gray-400 hover:text-violet-600"
                  onClick={() => { setEditArticle(article); setIsNew(false); }}
                >
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                  onClick={() => {
                    if (confirm("Delete this article?")) deleteMut.mutate({ id: article.id });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {(!articles || articles.length === 0) && (
            <EmptyState
              icon={<BookOpen className="h-8 w-8 text-gray-300" />}
              title="No articles yet"
              description="Click New Article to create your first help article"
            />
          )}
        </div>
      )}

      {/* Categories */}
      {view === "categories" && (
        <div className="flex flex-col gap-2">
          {categories?.map((cat) => (
            <div key={cat.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-white">
              <span className="text-lg">{cat.icon ?? "📁"}</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-800">{cat.name}</p>
                {cat.description && <p className="text-xs text-gray-500">{cat.description}</p>}
              </div>
            </div>
          ))}
          {(!categories || categories.length === 0) && (
            <p className="text-sm text-gray-500 text-center py-8">No categories yet</p>
          )}
        </div>
      )}

      {/* Insights */}
      {view === "insights" && insights && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Top Searches</h4>
            <div className="flex flex-col gap-1">
              {insights.topSearches?.map((s: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700">{s.query}</span>
                  <span className="text-gray-400">{s.count}x</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Unanswered Questions</h4>
            <div className="flex flex-col gap-1">
              {insights.unansweredQuestions?.map((q: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700 line-clamp-1">{q.query}</span>
                  <span className="text-gray-400">{q.count}x</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Most Helpful Articles</h4>
            <div className="flex flex-col gap-1">
              {insights.mostHelpful?.map((a: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700 line-clamp-1">{a.title}</span>
                  <span className="text-green-600">👍 {a.helpfulPct}%</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Needs Improvement</h4>
            <div className="flex flex-col gap-1">
              {insights.needsImprovement?.map((a: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-gray-700 line-clamp-1">{a.title}</span>
                  <span className="text-red-500">👎 {a.unhelpfulPct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Help Center Page ───────────────────────────────────────────────────── */

export default function HelpCenterPage() {
  const [activeTab, setActiveTab] = useState<Tab>("browse");
  const { data: me } = trpc.auth.me.useQuery();
  const isAdmin = (me as any)?.role === "admin" || (me as any)?.role === "owner";

  const tabs: { id: Tab; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { id: "browse", label: "Browse Articles", icon: <BookOpen className="h-4 w-4" /> },
    { id: "ask", label: "Ask AI", icon: <Bot className="h-4 w-4" /> },
    { id: "tours", label: "Guided Tours", icon: <GraduationCap className="h-4 w-4" /> },
    { id: "admin", label: "Admin", icon: <Settings className="h-4 w-4" />, adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <Shell title="Help Center">
      <PageHeader
        title="Help Center"
        description="Search articles, ask the AI assistant, or take a guided tour to learn the platform."
        pageKey="help"
      />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-6 px-6">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="px-6 pb-8">
        {activeTab === "browse" && <BrowseTab />}
        {activeTab === "ask" && <AskAITab />}
        {activeTab === "tours" && <ToursTab />}
        {activeTab === "admin" && isAdmin && <AdminTab />}
      </div>
    </Shell>
  );
}
