/**
 * The record drawer's LinkedIn tab: send a connection request or a DM from one
 * of your connected LinkedIn accounts.
 *
 * Moved out of RecordDrawer and fixed (audit 2026-10-20, R44):
 *  - the account and the profile were useState seeded on the FIRST render,
 *    before the account list or the record had loaded, so with one account
 *    Send stayed disabled and the profile field stayed empty. Both are now
 *    read from what has loaded until the person picks or types something;
 *  - a lead's profile is prefilled too (leads.get resolves it);
 *  - the DM sent the profile URL as a CHAT id, which is an existing
 *    conversation's id, so it could not start one. It sends the profile as
 *    the recipient, and the server resolves it to the attendee, as the
 *    sequence engine does.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Linkedin, Loader2, MessageSquare, Send, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";

export function LinkedInActionsPanel({
  relatedType,
  relatedId,
  linkedinUrl,
  name,
}: {
  relatedType: string;
  relatedId: number;
  linkedinUrl?: string | null;
  name: string;
}) {
  const utils = trpc.useUtils();
  const { data: accounts = [] } = trpc.unipile.listConnectedAccounts.useQuery();
  const linkedInAccounts = (accounts as any[]).filter((a) => a.provider === "LINKEDIN");

  // null = not chosen yet: follow what has loaded.
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  const [typedProfile, setTypedProfile] = useState<string | null>(null);
  const selectedAccountId = pickedAccountId ?? linkedInAccounts[0]?.unipileAccountId ?? "";
  const profileId = typedProfile ?? linkedinUrl ?? "";
  const [inviteMessage, setInviteMessage] = useState("");
  const [dmText, setDmText] = useState("");

  const sendInvite = trpc.unipile.sendLinkedInInvite.useMutation({
    onSuccess: () => {
      toast.success("Connection request sent!");
      setInviteMessage("");
      utils.activities.list.invalidate({ relatedType: relatedType as any, relatedId });
    },
    onError: (err) => toast.error("Failed to send invite", { description: err.message }),
  });

  const sendDm = trpc.unipile.sendMessage.useMutation({
    onSuccess: () => {
      toast.success("Direct message sent!");
      setDmText("");
      utils.activities.list.invalidate({ relatedType: relatedType as any, relatedId });
    },
    onError: (err) => toast.error("Failed to send DM", { description: err.message }),
  });

  if (linkedInAccounts.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center space-y-2">
        <Linkedin className="size-8 mx-auto text-[#0A66C2]" />
        <p className="text-sm font-medium">No LinkedIn account connected</p>
        <p className="text-xs text-muted-foreground">Go to <strong>Engage → Connected Accounts</strong> to link your LinkedIn account via Unipile.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Account selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Send from LinkedIn account</label>
        <select aria-label="Send from LinkedIn account"
          className="w-full border rounded-md px-3 py-2 text-sm h-10 bg-background"
          value={selectedAccountId}
          onChange={(e) => setPickedAccountId(e.target.value)}
        >
          {linkedInAccounts.map((a: any) => (
            <option key={a.unipileAccountId} value={a.unipileAccountId}>
              {a.accountName ?? a.unipileAccountId}
            </option>
          ))}
        </select>
      </div>

      {/* Profile ID / URL */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">LinkedIn Profile URL or ID</label>
        <input aria-label="LinkedIn Profile URL or ID"
          className="w-full border rounded-md px-3 py-2 text-sm h-10 bg-background"
          placeholder="https://linkedin.com/in/username or profile_id"
          value={profileId}
          onChange={(e) => setTypedProfile(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">Pre-filled from the record's LinkedIn profile if it has one.</p>
      </div>

      {/* Send Connection Request */}
      <div className="rounded-md border bg-card p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <UserPlus className="size-4 text-[#0A66C2]" />
          Send Connection Request
        </div>
        <Textarea aria-label="Personal note"
          placeholder="Add a personal note (optional, max 300 chars)…"
          value={inviteMessage}
          onChange={(e) => setInviteMessage(e.target.value.slice(0, 300))}
          rows={3}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{inviteMessage.length}/300</span>
          <Button
            size="sm"
            className="bg-[#0A66C2] hover:bg-[#0856a8] text-white"
            disabled={!selectedAccountId || !profileId.trim() || sendInvite.isPending}
            onClick={() => sendInvite.mutate({
              unipileAccountId: selectedAccountId,
              recipientProviderId: profileId.trim(),
              recipientName: name,
              message: inviteMessage || undefined,
              ...(relatedType === "contact" ? { linkedContactId: relatedId } : {}),
              ...(relatedType === "lead" ? { linkedLeadId: relatedId } : {}),
            })}
          >
            {sendInvite.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <UserPlus className="size-3.5 mr-1" />}
            Send Request
          </Button>
        </div>
      </div>

      {/* Send Direct Message */}
      <div className="rounded-md border bg-card p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="size-4 text-[#0A66C2]" />
          Send Direct Message
        </div>
        <Textarea aria-label={`Message to ${name}`}
          placeholder={`Write a message to ${name}…`}
          value={dmText}
          onChange={(e) => setDmText(e.target.value)}
          rows={4}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            className="bg-[#0A66C2] hover:bg-[#0856a8] text-white"
            disabled={!selectedAccountId || !profileId.trim() || !dmText.trim() || sendDm.isPending}
            onClick={() => sendDm.mutate({
              unipileAccountId: selectedAccountId,
              // A profile, not a chat: the server starts the conversation.
              recipientProfile: profileId.trim(),
              text: dmText.trim(),
              ...(relatedType === "contact" ? { linkedContactId: relatedId } : {}),
              ...(relatedType === "lead" ? { linkedLeadId: relatedId } : {}),
              ...(relatedType === "opportunity" ? { linkedOpportunityId: relatedId } : {}),
            })}
          >
            {sendDm.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Send className="size-3.5 mr-1" />}
            Send DM
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        LinkedIn actions are tracked as activities on this record and appear in the Timeline tab.
      </p>
    </div>
  );
}
