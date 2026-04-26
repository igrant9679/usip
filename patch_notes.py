with open('/home/ubuntu/usip/client/src/pages/usip/ARECampaignDetail.tsx', 'r') as f:
    lines = f.readlines()

NEW_COMPONENT = '''function ProspectNotes({ prospectId }: { prospectId: number }) {
  const utils = trpc.useUtils();
  const { data: notes, isLoading } = trpc.are.prospects.listNotes.useQuery({ prospectId });
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<"general" | "qualification" | "objection" | "follow_up" | "intel">("general");
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

  const invalidate = () => utils.are.prospects.listNotes.invalidate({ prospectId });

  const addNote = trpc.are.prospects.addNote.useMutation({
    onSuccess: () => { setDraft(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const editNote = trpc.are.prospects.editNote.useMutation({
    onSuccess: () => { setEditingId(null); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteNote = trpc.are.prospects.deleteNote.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });
  const pinNote = trpc.are.prospects.pinNote.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const CATEGORIES = [
    { value: "general", label: "General", color: "bg-muted text-muted-foreground" },
    { value: "qualification", label: "Qualification", color: "bg-blue-500/10 text-blue-600" },
    { value: "objection", label: "Objection", color: "bg-red-500/10 text-red-600" },
    { value: "follow_up", label: "Follow-up", color: "bg-amber-500/10 text-amber-600" },
    { value: "intel", label: "Intel", color: "bg-violet-500/10 text-violet-600" },
  ];
  const catColor = (cat: string) => CATEGORIES.find(c => c.value === cat)?.color ?? "bg-muted text-muted-foreground";
  const catLabel = (cat: string) => CATEGORIES.find(c => c.value === cat)?.label ?? cat;

  const filtered = (notes ?? []).filter(n => {
    const matchCat = filterCategory === "all" || n.category === filterCategory;
    const matchSearch = !search || n.body?.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }).sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));

  return (
    <div className="space-y-3 pb-8">
      {/* Search + filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="text-xs rounded-lg border bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {/* Compose */}
      <div className="space-y-2 rounded-xl border border-dashed border-border p-3 bg-muted/20">
        <div className="flex items-center gap-1.5 flex-wrap">
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              onClick={() => setDraftCategory(c.value as typeof draftCategory)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                draftCategory === c.value
                  ? c.color + " border-transparent font-medium"
                  : "border-border text-muted-foreground hover:border-primary/30"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note about this prospect…"
          className="text-sm min-h-[72px] resize-none"
          maxLength={4000}
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{draft.length}/4000</span>
          <Button
            size="sm" className="gap-1.5 text-xs"
            onClick={() => addNote.mutate({ prospectId, body: draft, category: draftCategory })}
            disabled={!draft.trim() || addNote.isPending}
          >
            {addNote.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <StickyNote className="size-3.5" />}
            Save Note
          </Button>
        </div>
      </div>

      {/* Notes list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" /> Loading notes...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <StickyNote className="size-8 opacity-30" />
          <div className="text-sm">{search || filterCategory !== "all" ? "No matching notes" : "No notes yet"}</div>
          <div className="text-xs opacity-60">Notes are private to your workspace.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((note) => (
            <div key={note.id} className={`rounded-xl border px-3 py-2.5 space-y-1.5 transition-all ${
              note.isPinned ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card"
            }`}>
              {editingId === note.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="text-xs min-h-[72px] resize-none"
                    maxLength={4000}
                    autoFocus
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">{editBody.length}/4000</span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="text-xs h-7 gap-1" onClick={() => editNote.mutate({ noteId: note.id, body: editBody })} disabled={!editBody.trim() || editNote.isPending}>
                        {editNote.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {note.isPinned && <Pin className="size-3 text-amber-500 mt-0.5 shrink-0" />}
                  <p className="text-xs leading-relaxed flex-1 whitespace-pre-wrap">{note.body}</p>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="p-1 rounded hover:bg-muted transition-colors"
                      onClick={() => { setEditingId(note.id); setEditBody(note.body); }}
                      title="Edit"
                    >
                      <Pencil className="size-3 text-muted-foreground" />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-muted transition-colors"
                      onClick={() => pinNote.mutate({ noteId: note.id, isPinned: !note.isPinned })}
                      title={note.isPinned ? "Unpin" : "Pin"}
                    >
                      <Pin className={`size-3 ${note.isPinned ? "text-amber-500" : "text-muted-foreground"}`} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => deleteNote.mutate({ noteId: note.id })}
                      title="Delete"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${catColor(note.category ?? "general")}`}>
                  {catLabel(note.category ?? "general")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(note.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {note.editedAt && <span className="ml-1 opacity-60">(edited)</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
'''

# Replace lines 437 to 520 (0-indexed: 436 to 519)
new_lines = lines[:436] + [NEW_COMPONENT + '\n'] + lines[520:]
with open('/home/ubuntu/usip/client/src/pages/usip/ARECampaignDetail.tsx', 'w') as f:
    f.writelines(new_lines)
print(f"Replaced ProspectNotes component ({520-436} lines -> new component)")
