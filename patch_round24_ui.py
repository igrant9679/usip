#!/usr/bin/env python3
"""
Patch ARECampaignDetail.tsx to add:
1. Download icon import
2. exportRejections + reEvaluate + getWorkspaceMembers queries/mutations in main component
3. Export CSV button on Rejections tab header
4. Re-evaluate button on each rejection row
5. @mention picker in ProspectNotes (getWorkspaceMembers query + dropdown)
"""

path = "/home/ubuntu/usip/client/src/pages/usip/ARECampaignDetail.tsx"
with open(path, "r") as f:
    content = f.read()

# ── 1. Add Download + AtSign icons to lucide import ──────────────────────────
content = content.replace(
    "  Activity,\n  ArrowLeft,",
    "  Activity,\n  ArrowLeft,\n  AtSign,\n  Download,\n  RefreshCcw,",
    1
)

# ── 2. Add exportRejections, reEvaluate, getWorkspaceMembers to main component ──
# Insert after the rejectionStats query line
old_queries = "  const { data: rejectionStats } = trpc.are.prospects.getRejectionStats.useQuery({ campaignId });"
new_queries = """  const { data: rejectionStats } = trpc.are.prospects.getRejectionStats.useQuery({ campaignId });
  const { data: csvData, refetch: fetchCsv } = trpc.are.prospects.exportRejections.useQuery(
    { campaignId },
    { enabled: false }
  );
  const reEvaluate = trpc.are.prospects.reEvaluate.useMutation({
    onSuccess: (d) => {
      toast.success(
        d.newStatus === "pending"
          ? `Re-qualified! New ICP score: ${d.newScore}`
          : `Still below threshold. New score: ${d.newScore}`
      );
      utils.are.prospects.getRejectionStats.invalidate({ campaignId });
      utils.are.prospects.list.invalidate({ campaignId });
    },
    onError: (e) => toast.error(e.message),
  });
  const handleExportCsv = async () => {
    const result = await fetchCsv();
    if (!result.data?.csv) { toast.error("No data to export"); return; }
    const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rejections-campaign-${campaignId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${result.data.count} rejections`);
  };"""
content = content.replace(old_queries, new_queries, 1)

# ── 3. Add Export CSV button to Rejections tab header ────────────────────────
old_rejections_header = """          <TabsContent value="rejections" className="mt-4">
            {(rejectionStats?.total ?? 0) === 0 ? (
              <EmptyState
                icon={XCircle}
                title="No rejections yet"
                description="Prospects you reject will appear here with their reasons and timestamps."
              />
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground mb-3">
                  {rejectionStats?.total} prospect{(rejectionStats?.total ?? 0) !== 1 ? "s" : ""} rejected across this campaign.
                  Use this log to refine your ICP or adjust scraper sources.
                </p>"""

new_rejections_header = """          <TabsContent value="rejections" className="mt-4">
            {(rejectionStats?.total ?? 0) === 0 ? (
              <EmptyState
                icon={XCircle}
                title="No rejections yet"
                description="Prospects you reject will appear here with their reasons and timestamps."
              />
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground">
                    {rejectionStats?.total} prospect{(rejectionStats?.total ?? 0) !== 1 ? "s" : ""} rejected.
                    Use this log to refine your ICP or adjust scraper sources.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7 gap-1.5"
                    onClick={handleExportCsv}
                  >
                    <Download className="size-3" />
                    Export CSV
                  </Button>
                </div>"""
content = content.replace(old_rejections_header, new_rejections_header, 1)

# ── 4. Add Re-evaluate button on each rejection row ──────────────────────────
old_rejection_row_end = """                    {item.rejectedAt && (
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(item.rejectedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}"""

new_rejection_row_end = """                    {item.rejectedAt && (
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(item.rejectedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[10px] h-6 px-2 gap-1 text-violet-600 hover:text-violet-700 hover:bg-violet-500/10 mt-0.5"
                        onClick={() => reEvaluate.mutate({ prospectId: item.id })}
                        disabled={reEvaluate.isPending}
                      >
                        {reEvaluate.isPending ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCcw className="size-3" />
                        )}
                        Re-evaluate
                      </Button>
                    </div>
                  </div>
                ))}"""
content = content.replace(old_rejection_row_end, new_rejection_row_end, 1)

# ── 5. Add @mention picker to ProspectNotes ──────────────────────────────────
# Add getWorkspaceMembers query and mention state after existing state declarations
old_notes_state = """  const invalidate = () => utils.are.prospects.listNotes.invalidate({ prospectId });
  const addNote = trpc.are.prospects.addNote.useMutation({"""

new_notes_state = """  const { data: workspaceMembers } = trpc.are.prospects.getWorkspaceMembers.useQuery();
  const [mentionQuery, setMentionQuery] = useState("");
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionAnchor, setMentionAnchor] = useState<number>(-1);
  const invalidate = () => utils.are.prospects.listNotes.invalidate({ prospectId });
  const addNote = trpc.are.prospects.addNote.useMutation({"""
content = content.replace(old_notes_state, new_notes_state, 1)

# Replace the Textarea in the compose section with one that handles @mentions
old_textarea = """        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note about this prospect\u2026"
          className="text-sm min-h-[72px] resize-none"
          maxLength={4000}
        />"""

new_textarea = """        <div className="relative">
          <Textarea
            value={draft}
            onChange={(e) => {
              const val = e.target.value;
              setDraft(val);
              // Detect @mention trigger
              const cursor = e.target.selectionStart ?? val.length;
              const textBefore = val.slice(0, cursor);
              const atIdx = textBefore.lastIndexOf("@");
              if (atIdx !== -1 && !textBefore.slice(atIdx).includes(" ")) {
                setMentionAnchor(atIdx);
                setMentionQuery(textBefore.slice(atIdx + 1));
                setShowMentionPicker(true);
              } else {
                setShowMentionPicker(false);
                setMentionAnchor(-1);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowMentionPicker(false);
            }}
            placeholder="Add a note\u2026 type @ to mention a teammate"
            className="text-sm min-h-[72px] resize-none"
            maxLength={4000}
          />
          {showMentionPicker && (workspaceMembers ?? []).filter(m =>
            !mentionQuery || m.name?.toLowerCase().includes(mentionQuery.toLowerCase())
          ).length > 0 && (
            <div className="absolute z-50 bottom-full mb-1 left-0 w-56 rounded-xl border bg-popover shadow-lg overflow-hidden">
              <div className="px-2 py-1 text-[10px] text-muted-foreground border-b flex items-center gap-1">
                <AtSign className="size-3" /> Mention a teammate
              </div>
              {(workspaceMembers ?? [])
                .filter(m => !mentionQuery || m.name?.toLowerCase().includes(mentionQuery.toLowerCase()))
                .slice(0, 6)
                .map((m) => (
                  <button
                    key={m.userId}
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-left"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      // Replace the @query with @name
                      const before = draft.slice(0, mentionAnchor);
                      const after = draft.slice(mentionAnchor + mentionQuery.length + 1);
                      setDraft(before + "@" + m.name + " " + after);
                      setShowMentionPicker(false);
                      setMentionQuery("");
                    }}
                  >
                    <div className="size-5 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium text-primary shrink-0">
                      {(m.name ?? "?")[0].toUpperCase()}
                    </div>
                    <span className="truncate">{m.name}</span>
                    {m.title && <span className="text-muted-foreground truncate text-[10px]">{m.title}</span>}
                  </button>
                ))}
            </div>
          )}
        </div>"""
content = content.replace(old_textarea, new_textarea, 1)

# ── 6. Render @mentions as highlighted chips in note body ────────────────────
old_note_body = """                  <p className="text-xs leading-relaxed flex-1 whitespace-pre-wrap\">{note.body}</p>"""
new_note_body = """                  <p className="text-xs leading-relaxed flex-1 whitespace-pre-wrap">
                    {note.body.split(/(@[\\w.\\- ]+)/).map((part, i) =>
                      part.startsWith("@") ? (
                        <span key={i} className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-violet-500/10 text-violet-600 font-medium text-[10px]">
                          <AtSign className="size-2.5" />{part.slice(1)}
                        </span>
                      ) : part
                    )}
                  </p>"""
content = content.replace(old_note_body, new_note_body, 1)

with open(path, "w") as f:
    f.write(content)

print("Done patching ARECampaignDetail.tsx")
