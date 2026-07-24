/**
 * Social — the real LinkedIn network surface, powered by Unipile.
 *
 * Scope: this page supports LEAD GENERATION — seeing who you've invited, who
 * you're connected to, and engaging a prospect's posts to warm them before an
 * invite (the same tactic Social Autopilot uses). Accounts are connected in
 * Settings › Social accounts.
 *
 * HISTORY: this page used to be "Social Publishing" — a scheduling queue,
 * calendar, accounts tab and analytics dashboard built on the `socialRouter`
 * stub (`social_accounts` / `social_posts`). That system was fake end-to-end:
 * `connectAccount` wrote a placeholder token and toasted "Connected (stub)",
 * `publishNowStub` invented impressions/engagements/clicks, and those numbers
 * were then aggregated into both the social analytics tab AND campaign
 * analytics as if they were real. All of it was removed (user-directed) —
 * only the genuine Unipile features below remain.
 */
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { ExternalLink, Send, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Social() {
  const utils = trpc.useUtils();

  // Pending invitations + connections (real LinkedIn via Unipile).
  const invites = trpc.unipile.listSentInvitations.useQuery({ limit: 100 } as any, { retry: false });
  const relations = trpc.unipile.listRelations.useQuery({ limit: 100 } as any, { retry: false });
  const withdraw = trpc.unipile.withdrawInvitation.useMutation({
    onSuccess: () => { utils.unipile.listSentInvitations.invalidate(); toast.success("Invitation withdrawn"); },
    onError: (e) => toast.error(e.message),
  });

  // Post engagement — warm a prospect before inviting them.
  const [postBody, setPostBody] = useState("");
  const [engageId, setEngageId] = useState("");
  const [engagePosts, setEngagePosts] = useState<any[]>([]);
  const [engaging, setEngaging] = useState(false);
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const createLinkedInPost = trpc.unipile.createPost.useMutation({
    onSuccess: () => { setPostBody(""); toast.success("Posted to LinkedIn"); },
    onError: (e) => toast.error(e.message.includes("PRECONDITION") ? "Connect a LinkedIn account first." : e.message),
  });
  const reactPost = trpc.unipile.reactToPost.useMutation({ onSuccess: () => toast.success("Liked"), onError: (e) => toast.error(e.message) });
  const commentPost = trpc.unipile.commentOnPost.useMutation({
    onSuccess: () => { setCommentFor(null); setCommentText(""); toast.success("Comment posted"); },
    onError: (e) => toast.error(e.message),
  });
  const lookupPosts = async () => {
    if (!engageId.trim()) return;
    setEngaging(true);
    try {
      const id = engageId.trim().replace(/\/+$/, "").split("/").pop() || engageId.trim();
      const res: any = await utils.unipile.listUserPosts.fetch({ identifier: id, limit: 5 } as any);
      setEngagePosts(res?.items ?? []);
      if (!res?.items?.length) toast.info("No posts found for that profile.");
    } catch (e: any) { toast.error(e?.message || "Lookup failed"); }
    finally { setEngaging(false); }
  };

  return (
    <Shell title="LinkedIn Network">
      <PageHeader
        title="LinkedIn Network"
        description="Your sent invitations, connections, and post engagement — powered by your connected LinkedIn account. Manage accounts in Settings › Social accounts."
        pageKey="social"
        icon={<Share2 className="size-5" />}
      />

      <div className="p-4 md:p-5 space-y-4">
        <Section title={`Pending LinkedIn invitations (${invites.data?.items?.length ?? 0})`}>
          {invites.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : invites.error ? (
            <div className="p-3 text-sm text-muted-foreground">Connect a LinkedIn account in Settings › Social accounts to see invitations.</div>
          ) : (invites.data?.items ?? []).length === 0 ? (
            <EmptyState icon={Send} title="No pending invitations" />
          ) : (
            <ul className="divide-y">
              {invites.data!.items.map((inv: any) => {
                const name = inv.invited_user_name || inv.invited_user_public_identifier || "LinkedIn member";
                const url = inv.invited_user_profile_url || (inv.invited_user_public_identifier ? `https://www.linkedin.com/in/${inv.invited_user_public_identifier}` : null);
                return (
                  <li key={inv.id} className="p-3 flex items-center gap-2 text-sm">
                    <StatusPill tone="info">linkedin</StatusPill>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{name}</div>
                      {inv.message && <div className="text-xs text-muted-foreground truncate">“{inv.message}”</div>}
                    </div>
                    <div className="ml-auto flex items-center gap-1">
                      {inv.date && <span className="text-xs text-muted-foreground">{fmtDate(inv.date)}</span>}
                      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                      <Button size="sm" variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate({ invitationId: String(inv.id) })}>Withdraw</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={`Connections (${relations.data?.items?.length ?? 0})`}>
          {relations.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : (relations.data?.items ?? []).length === 0 ? (
            <EmptyState icon={Share2} title="No connections loaded" />
          ) : (
            <ul className="divide-y">
              {relations.data!.items.map((r: any, i: number) => {
                const name = r.name || [r.first_name, r.last_name].filter(Boolean).join(" ") || r.public_identifier || "LinkedIn member";
                const url = r.public_profile_url || (r.public_identifier ? `https://www.linkedin.com/in/${r.public_identifier}` : null);
                return (
                  <li key={r.member_id || r.provider_id || i} className="p-3 flex items-center gap-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{name}</div>
                      {r.headline && <div className="text-xs text-muted-foreground truncate">{r.headline}</div>}
                    </div>
                    {url && <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Publish a LinkedIn post">
          <div className="p-3 space-y-2">
            <textarea
              value={postBody}
              onChange={(e) => setPostBody(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="Share an update, insight, or a bit of thought leadership… (posts from your connected LinkedIn account)"
              className="w-full rounded-md border bg-background p-2 text-sm resize-y"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{postBody.length}/3000 · posts to your own account</span>
              <Button size="sm" disabled={!postBody.trim() || createLinkedInPost.isPending} onClick={() => createLinkedInPost.mutate({ text: postBody.trim() })}>
                <Send className="size-3.5 mr-1.5" /> {createLinkedInPost.isPending ? "Posting…" : "Publish"}
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Engage a prospect's posts">
          <div className="p-3 space-y-3">
            <div className="flex gap-1.5">
              <input
                value={engageId}
                onChange={(e) => setEngageId(e.target.value)}
                placeholder="LinkedIn profile URL or public id (e.g. john-doe)"
                className="flex-1 rounded-md border bg-background px-2 h-9 text-sm"
                onKeyDown={(e) => { if (e.key === "Enter") lookupPosts(); }}
              />
              <Button size="sm" variant="outline" disabled={engaging} onClick={lookupPosts}>{engaging ? "Loading…" : "Find posts"}</Button>
            </div>
            {engagePosts.length > 0 && (
              <ul className="divide-y rounded-md border">
                {engagePosts.map((p: any, i: number) => {
                  const sid = p.social_id || p.id;
                  return (
                    <li key={sid || i} className="p-2.5 text-sm space-y-1.5">
                      <div className="whitespace-pre-wrap line-clamp-3 text-[13px]">{p.text || "(no text)"}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {p.date && <span>{fmtDate(p.date)}</span>}
                        {typeof p.reaction_counter === "number" && <span>· {p.reaction_counter} reactions</span>}
                        <div className="ml-auto flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7" disabled={!sid || reactPost.isPending} onClick={() => sid && reactPost.mutate({ socialId: String(sid) })}>👍 Like</Button>
                          <Button size="sm" variant="ghost" className="h-7" disabled={!sid} onClick={() => { setCommentFor(String(sid)); setCommentText(""); }}>💬 Comment</Button>
                        </div>
                      </div>
                      {commentFor === String(sid) && (
                        <div className="flex gap-1.5 pt-1">
                          <input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Write a comment…" className="flex-1 rounded-md border bg-background px-2 h-8 text-sm" onKeyDown={(e) => { if (e.key === "Enter" && commentText.trim()) commentPost.mutate({ socialId: String(sid), text: commentText.trim() }); }} />
                          <Button size="sm" className="h-8" disabled={!commentText.trim() || commentPost.isPending} onClick={() => commentPost.mutate({ socialId: String(sid), text: commentText.trim() })}>Post</Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </Shell>
  );
}
