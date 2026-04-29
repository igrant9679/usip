import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import {
  Linkedin,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Trash2,
  Save,
  Info,
  Users,
  ShieldCheck,
} from "lucide-react";

export default function MyLinkedIn() {
  const { current: workspace } = useWorkspace();

  const { data: myCredentials, isLoading, refetch } = trpc.linkedin.getMyCredentials.useQuery(
    undefined,
    { enabled: !!workspace },
  );

  const { data: teamCredentials } = trpc.linkedin.listTeamCredentials.useQuery(
    undefined,
    { enabled: !!workspace },
  );

  const saveMutation = trpc.linkedin.saveCredentials.useMutation({
    onSuccess: () => {
      toast.success("LinkedIn profile saved successfully.");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.linkedin.deleteCredentials.useMutation({
    onSuccess: () => {
      toast.success("LinkedIn credentials removed.");
      refetch();
      setProfileUrl("");
      setDisplayName("");
      setLinkedinId("");
      setCredentialValue("");
    },
    onError: (err) => toast.error(err.message),
  });

  const [profileUrl, setProfileUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [linkedinId, setLinkedinId] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  const [showCredentialField, setShowCredentialField] = useState(false);

  const isConnected = !!myCredentials;

  function handleSave() {
    saveMutation.mutate({
      profileUrl: profileUrl || undefined,
      displayName: displayName || undefined,
      linkedinId: linkedinId || undefined,
      credentialValue: credentialValue || undefined,
    });
  }

  const connectedCount = teamCredentials?.filter((m) => m.linkedinConnected).length ?? 0;
  const totalCount = teamCredentials?.length ?? 0;

  return (
    <Shell>
      <PageHeader
        title="My LinkedIn" pageKey="my-linkedin"
        description="Connect LinkedIn and manage outreach, connection requests, and InMail."
      
        icon={<Linkedin className="size-5" />}
      />

      <div className="max-w-3xl space-y-6">
        {/* Status banner */}
        {isConnected ? (
          <Alert className="border-green-200 bg-green-50">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">
              <span className="font-medium">LinkedIn profile connected</span>
              {myCredentials.displayName && ` as ${myCredentials.displayName}`}
              {myCredentials.syncedAt && (
                <span className="ml-2 text-green-600 text-xs">
                  · Last updated {new Date(myCredentials.syncedAt).toLocaleDateString()}
                </span>
              )}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="border-blue-200 bg-blue-50">
            <Info className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-800">
              Add your LinkedIn profile URL so the team can see your outreach coverage and so
              your profile link appears on contact records you own.
            </AlertDescription>
          </Alert>
        )}

        {/* Profile form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Linkedin className="h-5 w-5 text-[#0077B5]" />
              LinkedIn Profile
            </CardTitle>
            <CardDescription>
              Your profile information is visible to your team. No credential values are ever
              shared with other users.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isConnected && myCredentials.profileUrl && (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Current profile:</span>
                <a
                  href={myCredentials.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[#0077B5] hover:underline font-medium"
                >
                  {myCredentials.profileUrl}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  placeholder={isConnected ? (myCredentials.displayName ?? "Your name on LinkedIn") : "Your name on LinkedIn"}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="linkedinId">LinkedIn Handle / Member ID</Label>
                <Input
                  id="linkedinId"
                  placeholder={isConnected ? (myCredentials.linkedinId ?? "e.g. johndoe or 123456789") : "e.g. johndoe or 123456789"}
                  value={linkedinId}
                  onChange={(e) => setLinkedinId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your vanity URL handle (the part after linkedin.com/in/)
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="profileUrl">LinkedIn Profile URL</Label>
              <Input
                id="profileUrl"
                type="url"
                placeholder="https://www.linkedin.com/in/your-handle"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
              />
            </div>

            <Separator />

            {/* Optional credential storage */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Personal API Key / Token (Optional)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Store a personal LinkedIn API key or token for reference. Encrypted at rest
                    with AES-256-GCM. Only you can see it.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCredentialField(!showCredentialField)}
                >
                  {showCredentialField ? "Hide" : "Add credential"}
                </Button>
              </div>

              {showCredentialField && (
                <div className="space-y-1.5">
                  <Label htmlFor="credentialValue">API Key / Token</Label>
                  <Input
                    id="credentialValue"
                    type="password"
                    placeholder={
                      isConnected && myCredentials.hasToken
                        ? `Current: ${myCredentials.tokenMasked}`
                        : "Paste your LinkedIn API key or token"
                    }
                    value={credentialValue}
                    onChange={(e) => setCredentialValue(e.target.value)}
                  />
                  <Alert className="border-amber-200 bg-amber-50 py-2">
                    <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                    <AlertDescription className="text-amber-800 text-xs">
                      <strong>Important:</strong> LinkedIn's public API does not allow third-party
                      apps to send messages on your behalf. This credential is stored for your
                      personal reference only and is not used to automate any LinkedIn actions.
                      Actual outreach must be done directly in LinkedIn.
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending || (!profileUrl && !displayName && !linkedinId && !credentialValue)}
                className="gap-2"
              >
                <Save className="h-4 w-4" />
                {saveMutation.isPending ? "Saving…" : isConnected ? "Update Profile" : "Save Profile"}
              </Button>
              {isConnected && (
                <Button
                  variant="outline"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="gap-2 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  {deleteMutation.isPending ? "Removing…" : "Remove"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* How outreach works */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How LinkedIn Outreach Works in Velocity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#0077B5]/10 flex items-center justify-center text-[#0077B5] font-bold text-xs">1</div>
              <p>When a contact record has a LinkedIn URL, a <strong className="text-foreground">"Message on LinkedIn"</strong> button appears on their detail page.</p>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#0077B5]/10 flex items-center justify-center text-[#0077B5] font-bold text-xs">2</div>
              <p>Clicking it opens <strong className="text-foreground">LinkedIn directly in a new tab</strong> on the contact's profile, where you send the message manually.</p>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#0077B5]/10 flex items-center justify-center text-[#0077B5] font-bold text-xs">3</div>
              <p>After sending, you can <strong className="text-foreground">log the outreach as an activity</strong> in USIP to keep the CRM timeline current.</p>
            </div>
            <Alert className="border-muted">
              <Info className="h-3.5 w-3.5" />
              <AlertDescription className="text-xs">
                LinkedIn's API does not permit third-party apps to send messages or InMails
                programmatically without Sales Navigator partner approval. This is a LinkedIn
                platform restriction, not a Velocity limitation.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Team coverage */}
        {teamCredentials && teamCredentials.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" />
                Team LinkedIn Coverage
              </CardTitle>
              <CardDescription>
                {connectedCount} of {totalCount} team members have connected their LinkedIn profile
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {teamCredentials.map((member) => (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      {member.userAvatar ? (
                        <img
                          src={member.userAvatar}
                          alt={member.userName ?? ""}
                          className="w-7 h-7 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                          {(member.userName ?? "?")[0]?.toUpperCase()}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">{member.userName}</p>
                        {member.linkedinDisplayName && (
                          <p className="text-xs text-muted-foreground">{member.linkedinDisplayName}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.linkedinConnected ? (
                        <>
                          {member.linkedinProfileUrl && (
                            <a
                              href={member.linkedinProfileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#0077B5] hover:underline"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <Badge variant="outline" className="border-green-300 text-green-700 bg-green-50 gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Connected
                          </Badge>
                        </>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Not set up
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Shell>
  );
}
