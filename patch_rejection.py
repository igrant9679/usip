with open('/home/ubuntu/usip/client/src/pages/usip/ARECampaignDetail.tsx', 'r') as f:
    content = f.read()

# 1. Add getRejectionStats query after the abVariants query
OLD_QUERY = "  const { data: abVariants } = trpc.are.prospects.getAbVariants.useQuery({ campaignId });"
NEW_QUERY = """  const { data: abVariants } = trpc.are.prospects.getAbVariants.useQuery({ campaignId });
  const { data: rejectionStats } = trpc.are.prospects.getRejectionStats.useQuery({ campaignId });"""
content = content.replace(OLD_QUERY, NEW_QUERY)

# 2. Add REJECT_TEMPLATES constant after the SIGNAL_COLORS constant
OLD_CONST = "/* ─── ICP score ring"
NEW_CONST = """const REJECT_TEMPLATES = [
  "Wrong industry",
  "Company too small",
  "Company too large",
  "Already a customer",
  "Competitor",
  "No decision-making authority",
  "Outside target geography",
  "Budget constraints",
  "Not the right timing",
  "Duplicate prospect",
];

/* ─── ICP score ring"""
content = content.replace(OLD_CONST, NEW_CONST)

# 3. Add rejection analytics card between the metrics row and the Tabs section
OLD_TABS = '        {/* -- Tabs -- */}\n        <Tabs defaultValue="prospects">'
NEW_TABS = '''        {/* -- Rejection analytics (only shown when there are rejections) -- */}
        {(rejectionStats?.total ?? 0) > 0 && (
          <Card className="bg-card border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <XCircle className="size-4 text-destructive/70" />
                Rejection Analytics
                <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0 h-5 border-destructive/30 text-destructive">
                  {rejectionStats?.total} rejected
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="space-y-2">
                {(rejectionStats?.byReason ?? []).map(({ reason, count }) => {
                  const pct = Math.round((count / (rejectionStats?.total ?? 1)) * 100);
                  return (
                    <div key={reason} className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground truncate max-w-[70%]">{reason}</span>
                        <span className="font-medium tabular-nums">{count} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
                      </div>
                      <Progress value={pct} className="h-1.5" />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
        {/* -- Tabs -- */}
        <Tabs defaultValue="prospects">'''
content = content.replace(OLD_TABS, NEW_TABS)

# 4. Add Rejections tab trigger after the Settings trigger
OLD_TRIGGER = '            <TabsTrigger value="settings" className="text-xs gap-1.5">\n              <Settings className="size-3.5" /> Settings\n            </TabsTrigger>'
NEW_TRIGGER = '''            <TabsTrigger value="settings" className="text-xs gap-1.5">
              <Settings className="size-3.5" /> Settings
            </TabsTrigger>
            <TabsTrigger value="rejections" className="text-xs gap-1.5">
              <XCircle className="size-3.5" /> Rejections
              {(rejectionStats?.total ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-destructive/15 text-destructive rounded-full px-1.5 py-0.5 font-medium">
                  {rejectionStats?.total}
                </span>
              )}
            </TabsTrigger>'''
content = content.replace(OLD_TRIGGER, NEW_TRIGGER)

# 5. Add rejection reason templates to the reject dialog
OLD_DIALOG_TEXTAREA = '''            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Rejection reason (optional) — e.g. wrong industry, too small, already a customer…"
              className="text-sm min-h-[80px] resize-none"
            />'''
NEW_DIALOG_TEXTAREA = '''            <div className="flex flex-wrap gap-1.5">
              {REJECT_TEMPLATES.map((t) => (
                <button
                  key={t}
                  onClick={() => setRejectReason(t)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                    rejectReason === t
                      ? "border-destructive/50 bg-destructive/10 text-destructive font-medium"
                      : "border-border text-muted-foreground hover:border-destructive/30 hover:text-destructive/80"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Or type a custom reason…"
              className="text-sm min-h-[60px] resize-none"
            />'''
content = content.replace(OLD_DIALOG_TEXTAREA, NEW_DIALOG_TEXTAREA)

# 6. Add Rejections TabsContent before the closing </Tabs>
# Find the settings TabsContent closing and insert the rejections tab after it
# We'll insert before the </Tabs> closing tag that follows the settings content
# Find the last </TabsContent> before </Tabs>
OLD_TABS_END = '          </TabsContent>\n        </Tabs>'
NEW_TABS_END = '''          </TabsContent>
          {/* -- Rejections audit trail tab -- */}
          <TabsContent value="rejections" className="mt-4">
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
                </p>
                {(rejectionStats?.items ?? []).map((item: any) => (
                  <div key={item.id} className="flex items-start gap-3 rounded-xl border px-3 py-2.5 bg-card">
                    <XCircle className="size-4 text-destructive/60 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {item.contactName || [item.firstName, item.lastName].filter(Boolean).join(" ") || "Unknown"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{item.companyName ?? "—"}</div>
                      {item.contactTitle && (
                        <div className="text-[10px] text-muted-foreground">{item.contactTitle}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-right space-y-0.5">
                      {item.rejectionReason ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-destructive/20 text-destructive/80 max-w-[160px] truncate block">
                          {item.rejectionReason}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">No reason given</span>
                      )}
                      {item.rejectedAt && (
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(item.rejectedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>'''
# Replace only the last occurrence (settings TabsContent end)
idx = content.rfind(OLD_TABS_END)
if idx != -1:
    content = content[:idx] + NEW_TABS_END + content[idx + len(OLD_TABS_END):]
    print("Inserted Rejections tab content")
else:
    print("ERROR: could not find </TabsContent>\\n        </Tabs>")

with open('/home/ubuntu/usip/client/src/pages/usip/ARECampaignDetail.tsx', 'w') as f:
    f.write(content)
print("Done patching rejection workflow")
