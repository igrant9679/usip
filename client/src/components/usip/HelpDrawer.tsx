/**
 * HelpDrawer — slide-over help panel
 *
 * Three tabs:
 *  1. Search — full-text article search with instant results
 *  2. Ask AI — conversational AI helper with cited articles
 *  3. Guided Tours — list of available tours for current page + all tours
 *
 * Context-aware: uses `pageKey` from current route to filter articles and tours.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { useTourEngine } from "./TourEngine";

/* ─── helpers ────────────────────────────────────────────────────────────── */

function routeToPageKey(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg[0] ?? "dashboard";
}

function timeSince(dateStr: string | Date) {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function SearchTab({ pageKey }: { pageKey: string }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  const { data: results, isFetching } = trpc.helpCenter.searchArticles.useQuery(
    { query: debouncedQuery, limit: 8 },
    { enabled: debouncedQuery.length >= 2 },
  );

  const { data: pageArticles } = trpc.helpCenter.listArticles.useQuery(
    { pageKey, status: "published", limit: 6 },
    { enabled: debouncedQuery.length < 2 },
  );

  const logClick = trpc.helpCenter.logSearchClick.useMutation();

  const displayItems = debouncedQuery.length >= 2 ? results : pageArticles;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help articles…"
          className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 pr-8"
          autoFocus
        />
        {isFetching && (
          <div className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
        )}
      </div>

      {debouncedQuery.length < 2 && (
        <p className="text-xs text-gray-400 px-1">
          {pageArticles?.length ? `Articles for this page` : "Type to search all articles"}
        </p>
      )}

      {debouncedQuery.length >= 2 && results?.length === 0 && !isFetching && (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500">No results for "{debouncedQuery}"</p>
          <p className="text-xs text-gray-400 mt-1">Try the Ask AI tab for a direct answer</p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {displayItems?.map((article) => (
          <button
            key={article.id}
            onClick={() => {
              if (debouncedQuery) logClick.mutate({ query: debouncedQuery, articleId: article.id });
              window.open(`/help/articles/${article.slug}`, "_blank");
            }}
            className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2.5 hover:border-violet-200 hover:bg-violet-50 transition-colors"
          >
            <p className="text-sm font-medium text-gray-800 line-clamp-1">{article.title}</p>
            {article.summary && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{article.summary}</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Ask AI Tab ─────────────────────────────────────────────────────────── */

type Message = { role: "user" | "assistant"; body: string; citedArticleIds?: number[] };

function AskAITab({ pageKey }: { pageKey: string }) {
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
      const res = await askAI.mutateAsync({ conversationId: convId, message: userMsg, pageKey });
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
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 pb-2 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">🤖</span>
            </div>
            <p className="text-sm font-medium text-gray-700">Ask me anything</p>
            <p className="text-xs text-gray-400 mt-1">I know everything about this platform</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-violet-600 text-white"
                  : "bg-gray-100 text-gray-800"
              }`}
            >
              <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
              {msg.citedArticleIds && msg.citedArticleIds.length > 0 && (
                <p className="text-xs mt-1 opacity-60">
                  Sources: Article {msg.citedArticleIds.join(", ")}
                </p>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-xl px-3 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 pt-2 border-t border-gray-100">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="Ask a question…"
          className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          disabled={isLoading}
        />
        <button
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
          className="px-3 py-2 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-40 rounded-lg"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/* ─── Guided Tours Tab ───────────────────────────────────────────────────── */

function ToursTab({ pageKey }: { pageKey: string }) {
  const { startTour } = useTourEngine();
  const utils = trpc.useUtils();
  const { data: recommended } = trpc.tours.getRecommended.useQuery({ pageKey });
  const { data: allTours } = trpc.tours.list.useQuery({ type: "all", status: "published" });
  const { data: myProgress } = trpc.tours.getMyProgress.useQuery();

  const progressMap = Object.fromEntries((myProgress ?? []).map((p) => [p.tourId, p]));

  const typeLabel: Record<string, string> = {
    onboarding: "🎓 Onboarding",
    feature: "⭐ Feature",
    whats_new: "🆕 What's New",
    custom: "🏆 Custom",
  };

  function TourCard({ tour }: { tour: any }) {
    const prog = progressMap[tour.id];
    const isCompleted = prog?.status === "completed";
    const isInProgress = prog?.status === "in_progress";
    const [loading, setLoading] = useState(false);

    const handleStart = useCallback(async () => {
      setLoading(true);
      try {
        const full = await utils.tours.get.fetch({ id: tour.id });
        startTour(full);
      } catch {
        // fall back silently
      } finally {
        setLoading(false);
      }
    }, [tour.id]);

    return (
      <div className="rounded-lg border border-gray-100 bg-white px-3 py-2.5 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-violet-500 font-medium">
              {typeLabel[tour.type] ?? tour.type}
            </span>
            {isCompleted && (
              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">✓ Done</span>
            )}
            {isInProgress && (
              <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">In progress</span>
            )}
          </div>
          <p className="text-sm font-medium text-gray-800 mt-0.5 line-clamp-1">{tour.name}</p>
          {tour.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{tour.description}</p>
          )}
          {tour.estimatedMinutes && (
            <p className="text-xs text-gray-400 mt-1">~{tour.estimatedMinutes} min</p>
          )}
        </div>
        <button
          onClick={handleStart}
          disabled={loading}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-violet-600 border border-violet-200 hover:bg-violet-50 rounded-lg disabled:opacity-50"
        >
          {loading ? "Loading…" : isCompleted ? "Replay" : isInProgress ? "Resume" : "Start"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {recommended && recommended.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Suggested for this page
          </p>
          <div className="flex flex-col gap-2">
            {recommended.map((tour) => (
              <TourCard key={tour.id} tour={tour} />
            ))}
          </div>
        </div>
      )}

      {allTours && allTours.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            All tours
          </p>
          <div className="flex flex-col gap-2">
            {allTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} />
            ))}
          </div>
        </div>
      )}

      {(!allTours || allTours.length === 0) && (
        <div className="text-center py-8">
          <p className="text-sm text-gray-500">No tours available yet</p>
          <p className="text-xs text-gray-400 mt-1">Admins can create tours in Help Center → Tour Builder</p>
        </div>
      )}
    </div>
  );
}

/* ─── HelpDrawer ─────────────────────────────────────────────────────────── */

type Tab = "search" | "ask" | "tours";

export function HelpDrawer({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>("search");
  const [location] = useLocation();
  const pageKey = routeToPageKey(location);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "search", label: "Search", icon: "🔍" },
    { id: "ask", label: "Ask AI", icon: "🤖" },
    { id: "tours", label: "Tours", icon: "🎓" },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[9970] bg-black/20"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-[9975] w-[380px] bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-violet-600 font-bold text-sm">Help Center</span>
            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{pageKey}</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? "text-violet-600 border-b-2 border-violet-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {activeTab === "search" && <SearchTab pageKey={pageKey} />}
          {activeTab === "ask" && <AskAITab pageKey={pageKey} />}
          {activeTab === "tours" && <ToursTab pageKey={pageKey} />}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
          <a
            href="/help"
            className="text-xs text-violet-500 hover:text-violet-700 font-medium"
          >
            Open full Help Center →
          </a>
          <a
            href="/help/tour-builder"
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Build a tour
          </a>
        </div>
      </div>
    </>
  );
}

/* ─── HelpButton ─────────────────────────────────────────────────────────── */

export function HelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Persistent ? button */}
      <button
        data-tour-id="help-button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-[9960] w-11 h-11 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg flex items-center justify-center text-lg font-bold transition-transform hover:scale-105"
        title="Help & Tours"
        aria-label="Open Help Center"
      >
        ?
      </button>

      {open && <HelpDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
