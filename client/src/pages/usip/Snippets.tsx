/**
 * Snippet Library — reusable text/HTML snippets for email composition
 */
import { useState } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { BookOpen, Check, Copy, Edit2, Plus, Search, Trash2, Wand2, Scissors } from "lucide-react";

type SnippetCategory = "opener" | "value_prop" | "social_proof" | "objection_handler" | "cta" | "closing" | "ps";
const CATEGORIES: SnippetCategory[] = ["opener", "value_prop", "social_proof", "objection_handler", "cta", "closing", "ps"];

const CATEGORY_LABELS: Record<SnippetCategory, string> = {
  opener: "Opener",
  value_prop: "Value Prop",
  social_proof: "Social Proof",
  objection_handler: "Objection Handler",
  cta: "Call to Action",
  closing: "Closing",
  ps: "P.S.",
};

interface SnippetForm {
  name: string;
  category: SnippetCategory;
  bodyPlain: string;
  bodyHtml: string;
  mergeTagsUsed: string[];
  isHtml: boolean;
}

const DEFAULT_FORM: SnippetForm = {
  name: "",
  category: "opener",
  bodyPlain: "",
  bodyHtml: "",
  mergeTagsUsed: [],
  isHtml: false,
};

const MERGE_TAGS = ["{{firstName}}", "{{lastName}}", "{{company}}", "{{title}}", "{{senderName}}"];

export default function SnippetsPage() {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<"all" | SnippetCategory>("all");
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<SnippetForm>(DEFAULT_FORM);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const { data: snippets, isLoading } = trpc.snippets.list.useQuery({
    category: filterCategory === "all" ? undefined : filterCategory,
    search: search || undefined,
  });
  const utils = trpc.useUtils();

  const createMutation = trpc.snippets.create.useMutation({
    onSuccess: () => {
      utils.snippets.list.invalidate();
      toast.success("Snippet created");
      setShowDialog(false);
      setForm(DEFAULT_FORM);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.snippets.update.useMutation({
    onSuccess: () => {
      utils.snippets.list.invalidate();
      toast.success("Snippet updated");
      setShowDialog(false);
      setEditId(null);
      setForm(DEFAULT_FORM);
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.snippets.delete.useMutation({
    onSuccess: () => {
      utils.snippets.list.invalidate();
      toast.success("Snippet deleted");
    },
    onError: (e) => toast.error(e.message),
  });

  const generateMutation = trpc.snippets.generate.useMutation({
    onSuccess: (data) => {
      setForm((f) => ({ ...f, bodyPlain: data.content, bodyHtml: `<p>${data.content}</p>` }));
      setIsGenerating(false);
    },
    onError: (e) => {
      toast.error(e.message);
      setIsGenerating(false);
    },
  });

  const openCreate = () => {
    setEditId(null);
    setForm(DEFAULT_FORM);
    setShowDialog(true);
  };

  const openEdit = (snippet: any) => {
    setEditId(snippet.id);
    setForm({
      name: snippet.name,
      category: snippet.category as SnippetCategory,
      bodyPlain: snippet.bodyPlain ?? "",
      bodyHtml: snippet.bodyHtml ?? "",
      mergeTagsUsed: (snippet.mergeTagsUsed as string[]) ?? [],
      isHtml: false,
    });
    setShowDialog(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.bodyPlain.trim()) {
      toast.error("Name and content are required");
      return;
    }
    const payload = {
      name: form.name,
      category: form.category,
      bodyPlain: form.bodyPlain,
      bodyHtml: form.bodyHtml || `<p>${form.bodyPlain}</p>`,
      mergeTagsUsed: MERGE_TAGS.filter((t) => form.bodyPlain.includes(t)),
    };
    if (editId) {
      updateMutation.mutate({ id: editId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleCopy = (snippet: any) => {
    navigator.clipboard.writeText(snippet.bodyPlain ?? snippet.bodyHtml ?? "");
    setCopiedId(snippet.id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success("Copied to clipboard");
  };

  const handleGenerate = () => {
    if (!form.category) return;
    setIsGenerating(true);
    generateMutation.mutate({ category: form.category, tone: "professional" });
  };

  const filtered = snippets ?? [];

  return (
    <Shell title="Snippet Library">
      <PageHeader
        title="Snippet Library" pageKey="snippets"
        description="Create reusable text snippets and personalisation tokens for email templates."
      
        icon={<Scissors className="size-5" />}
      >
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1.5" /> New Snippet
        </Button>
      </PageHeader>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search snippets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={filterCategory} onValueChange={(v) => setFilterCategory(v as any)}>
          <SelectTrigger className="h-9 w-48">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{filtered.length} snippet{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BookOpen size={40} className="text-muted-foreground mb-4" />
          <p className="text-lg font-semibold">No snippets found</p>
          <p className="text-sm text-muted-foreground mt-1">
            {search ? "Try a different search term" : "Create your first snippet to get started"}
          </p>
          {!search && (
            <Button className="mt-4" onClick={openCreate}>
              <Plus size={14} className="mr-1.5" /> Create Snippet
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((snippet: any) => (
            <Card key={snippet.id} className="group hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm font-semibold truncate">{snippet.name}</CardTitle>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {CATEGORY_LABELS[snippet.category as SnippetCategory] ?? snippet.category}
                      </Badge>
                      {(snippet.mergeTagsUsed as string[])?.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {(snippet.mergeTagsUsed as string[]).length} tag{(snippet.mergeTagsUsed as string[]).length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCopy(snippet)}>
                      {copiedId === snippet.id ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(snippet)}>
                      <Edit2 size={12} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 hover:text-destructive"
                      onClick={() => deleteMutation.mutate({ id: snippet.id })}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground line-clamp-4 leading-relaxed">
                  {snippet.bodyPlain}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={showDialog} onOpenChange={(o) => { setShowDialog(o); if (!o) { setEditId(null); setForm(DEFAULT_FORM); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Snippet" : "New Snippet"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Name *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Warm Intro Opener"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as SnippetCategory }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Content *</Label>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <div className="animate-spin rounded-full h-3 w-3 border border-primary border-t-transparent mr-1.5" />
                  ) : (
                    <Wand2 size={11} className="mr-1.5" />
                  )}
                  AI Generate
                </Button>
              </div>
              <Textarea
                value={form.bodyPlain}
                onChange={(e) => setForm((f) => ({ ...f, bodyPlain: e.target.value }))}
                placeholder="Your snippet text with {{firstName}} tokens…"
                className="min-h-[140px] resize-y text-sm"
              />
              <div className="flex flex-wrap gap-1 mt-1">
                {MERGE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setForm((f) => ({ ...f, bodyPlain: f.bodyPlain + tag }))}
                    className="text-[10px] bg-muted hover:bg-primary/10 hover:text-primary rounded px-1.5 py-0.5 font-mono transition-colors"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending}>
              {editId ? "Save Changes" : "Create Snippet"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
