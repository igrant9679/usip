import { useState } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  ClipboardList,
  Building2,
  Calendar,
  DollarSign,
  FileText,
  MessageSquare,
  CheckCircle2,
  Clock,
  Eye,
  XCircle,
  RotateCcw,
  ThumbsUp,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const STATUS_CONFIG = {
  draft: { label: "Draft", color: "bg-slate-100 text-slate-600 border-slate-200" },
  sent: { label: "Sent to Client", color: "bg-blue-50 text-blue-700 border-blue-200" },
  under_review: { label: "Under Review", color: "bg-amber-50 text-amber-700 border-amber-200" },
  accepted: { label: "Accepted", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  not_accepted: { label: "Not Accepted", color: "bg-red-50 text-red-700 border-red-200" },
  revision_requested: { label: "Revision Requested", color: "bg-orange-50 text-orange-700 border-orange-200" },
} as const;

const SECTION_LABELS: Record<string, string> = {
  executive_summary: "Executive Summary",
  firm_overview: "Firm Overview",
  our_approach: "Our Approach",
  timeline_narrative: "Timeline Narrative",
  pricing: "Pricing",
  case_studies: "Case Studies",
  references: "References",
  terms: "Terms & Conditions",
};

export default function ProposalPortal() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";

  const { data, isLoading, error } = trpc.proposals.getByShareToken.useQuery(
    { token },
    { enabled: !!token },
  );

  const [feedbackForm, setFeedbackForm] = useState({ name: "", email: "", message: "" });
  const [submitted, setSubmitted] = useState(false);

  const submitFeedback = trpc.proposals.submitFeedback.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      toast.success("Feedback submitted — thank you!");
    },
    onError: (e) => toast.error(e.message),
  });
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const acceptMutation = trpc.proposals.acceptByToken.useMutation({
    onSuccess: (data) => {
      setAccepted(true);
      setAcceptDialogOpen(false);
      if (data.alreadyAccepted) {
        toast.info("This proposal was already accepted.");
      } else {
        toast.success("Proposal accepted! The team has been notified.");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-full max-w-3xl p-8 space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-sm p-8">
          <ClipboardList className="size-14 text-gray-300 mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-gray-800 mb-2">Proposal Not Found</h1>
          <p className="text-gray-500 text-sm">
            This proposal link is invalid or has expired. Please contact the sender for a new link.
          </p>
        </div>
      </div>
    );
  }

  const { proposal, sections, milestones } = data;
  const statusCfg = STATUS_CONFIG[proposal.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.draft;
  const sectionMap: Record<string, string> = {};
  for (const s of sections) sectionMap[s.sectionKey] = s.content;
  const populatedSections = Object.entries(sectionMap).filter(([, v]) => v?.trim());

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-5 text-teal-600" />
            <span className="font-semibold text-gray-800">Proposal</span>
          </div>
          <span className={cn("text-xs px-2.5 py-1 rounded-full border font-medium", statusCfg.color)}>
            {statusCfg.label}
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Hero */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{proposal.title}</h1>
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 mt-2">
            <span className="flex items-center gap-1.5">
              <Building2 className="size-4 text-teal-500" />
              {proposal.clientName}
              {proposal.orgAbbr && ` (${proposal.orgAbbr})`}
            </span>
            {proposal.projectType && (
              <span className="flex items-center gap-1.5">
                <FileText className="size-4 text-teal-500" />
                {proposal.projectType}
              </span>
            )}
            {proposal.budget && (
              <span className="flex items-center gap-1.5">
                <DollarSign className="size-4 text-teal-500" />
                ${Number(proposal.budget).toLocaleString()}
              </span>
            )}
            {proposal.rfpDeadline && (
              <span className="flex items-center gap-1.5">
                <Calendar className="size-4 text-teal-500" />
                Due {new Date(proposal.rfpDeadline).toLocaleDateString()}
              </span>
            )}
          </div>
          {proposal.description && (
            <p className="text-gray-600 text-sm leading-relaxed mt-4 border-t border-gray-100 pt-4">
              {proposal.description}
            </p>
          )}
          {/* Accept Proposal CTA */}
          {proposal.status !== "accepted" && !accepted && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-3">
              <Button
                onClick={() => setAcceptDialogOpen(true)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
              >
                <ThumbsUp className="size-4" />
                Accept This Proposal
              </Button>
              <p className="text-xs text-gray-400">
                Accepting notifies the team and creates a follow-up action.
              </p>
            </div>
          )}
          {(proposal.status === "accepted" || accepted) && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="size-5 text-emerald-500" />
              <span className="text-sm font-medium">This proposal has been accepted.</span>
            </div>
          )}
        </div>

        <Tabs defaultValue={populatedSections.length > 0 ? "content" : "timeline"} className="space-y-4">
          <TabsList className="bg-white border border-gray-200 rounded-lg p-1 gap-1 h-auto flex-wrap">
            {populatedSections.length > 0 && (
              <TabsTrigger value="content" className="rounded-md data-[state=active]:bg-teal-600 data-[state=active]:text-white text-sm">
                Proposal Content
              </TabsTrigger>
            )}
            {milestones.length > 0 && (
              <TabsTrigger value="timeline" className="rounded-md data-[state=active]:bg-teal-600 data-[state=active]:text-white text-sm">
                Timeline
              </TabsTrigger>
            )}
            <TabsTrigger value="feedback" className="rounded-md data-[state=active]:bg-teal-600 data-[state=active]:text-white text-sm">
              Submit Feedback
            </TabsTrigger>
          </TabsList>

          {/* Content sections */}
          {populatedSections.length > 0 && (
            <TabsContent value="content" className="mt-0 space-y-4">
              {populatedSections.map(([key, content]) => (
                <div key={key} className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                  <h2 className="text-base font-semibold text-gray-800 mb-3 pb-2 border-b border-gray-100">
                    {SECTION_LABELS[key] ?? key}
                  </h2>
                  <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{content}</div>
                </div>
              ))}
            </TabsContent>
          )}

          {/* Timeline */}
          {milestones.length > 0 && (
            <TabsContent value="timeline" className="mt-0">
              <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                <h2 className="text-base font-semibold text-gray-800 mb-4">Project Timeline</h2>
                <div className="space-y-3">
                  {milestones.map((m: any, idx: number) => (
                    <div key={m.id} className="flex items-start gap-3">
                      <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
                        <div className="size-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-bold">
                          {idx + 1}
                        </div>
                        {idx < milestones.length - 1 && <div className="w-px h-4 bg-gray-200" />}
                      </div>
                      <div className="flex-1 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-800">{m.name}</span>
                          {m.milestoneDate && (
                            <span className="text-xs text-gray-400 flex items-center gap-1">
                              <Calendar className="size-3" />
                              {new Date(m.milestoneDate).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        {m.description && <p className="text-xs text-gray-500 mt-0.5">{m.description}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>
          )}

          {/* Feedback */}
          <TabsContent value="feedback" className="mt-0">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-gray-800 mb-1">Submit Feedback</h2>
              <p className="text-sm text-gray-500 mb-4">
                Have questions or comments about this proposal? Send them directly to the team.
              </p>

              {submitted ? (
                <div className="flex flex-col items-center py-8 text-center">
                  <CheckCircle2 className="size-12 text-teal-500 mb-3" />
                  <p className="font-semibold text-gray-800">Feedback received!</p>
                  <p className="text-sm text-gray-500 mt-1">The team will follow up with you shortly.</p>
                </div>
              ) : (
                <div className="space-y-4 max-w-md">
                  <div>
                    <Label className="text-gray-700">Your Name *</Label>
                    <Input
                      value={feedbackForm.name}
                      onChange={(e) => setFeedbackForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Jane Smith"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-gray-700">Email (optional)</Label>
                    <Input
                      type="email"
                      value={feedbackForm.email}
                      onChange={(e) => setFeedbackForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="jane@company.com"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-gray-700">Message *</Label>
                    <Textarea
                      value={feedbackForm.message}
                      onChange={(e) => setFeedbackForm(f => ({ ...f, message: e.target.value }))}
                      placeholder="Your questions or comments about this proposal..."
                      className="mt-1 min-h-[120px]"
                    />
                  </div>
                  <Button
                    onClick={() => submitFeedback.mutate({
                      token,
                      authorName: feedbackForm.name,
                      authorEmail: feedbackForm.email || undefined,
                      message: feedbackForm.message,
                    })}
                    disabled={!feedbackForm.name.trim() || !feedbackForm.message.trim() || submitFeedback.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
                  >
                    <MessageSquare className="size-4" />
                    {submitFeedback.isPending ? "Submitting..." : "Submit Feedback"}
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* Accept Proposal dialog */}
      <Dialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Accept This Proposal?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-gray-600">
            <p>
              By accepting, you confirm that <strong>{proposal.clientName}</strong> agrees to move forward with{" "}
              <strong>{proposal.title}</strong>.
            </p>
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-emerald-800 text-xs">
              <p className="font-medium mb-1">What happens next:</p>
              <ul className="space-y-0.5">
                <li>• The proposal team is notified immediately</li>
                <li>• A follow-up task is created for your account manager</li>
                <li>• You can still submit feedback via the Feedback tab</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => acceptMutation.mutate({ token })}
              disabled={acceptMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              <ThumbsUp className="size-4" />
              {acceptMutation.isPending ? "Accepting..." : "Yes, Accept"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <footer className="text-center py-6 text-xs text-gray-400 border-t border-gray-200 mt-8">
        Powered by USIP — Unified Sales Intelligence Platform
      </footer>
    </div>
  );
}
