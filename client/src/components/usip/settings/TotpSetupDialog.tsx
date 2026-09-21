/**
 * Two-step authenticator enrollment: show the minted secret, then confirm a
 * live code.
 *
 * Lived inside SettingsHub until 2026-09-20. It moved out because workspace
 * `enforce2fa` enforcement needs the same dialog from MfaRequiredGate, and a
 * blocked member cannot reach SettingsHub at all — every query that page
 * fires is behind the gate. One copy, so the enrolment flow cannot drift
 * between the place you choose it and the place you are forced into it.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Copy, Loader2 } from "lucide-react";

export function TotpSetupDialog({
  open,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful confirm, so the enforce2fa interstitial can
   *  refetch everything it was refused and dismiss itself. */
  onConfirmed?: () => void;
}) {
  const utils = trpc.useUtils();
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const start = trpc.profile.startTotpEnrollment.useMutation({
    onSuccess: (r: any) => setEnroll(r),
    onError: (e: any) => { toast.error(e?.message ?? "Could not start enrollment"); onClose(); },
  });
  const confirm = trpc.profile.confirmTotpEnrollment.useMutation({
    onSuccess: () => {
      toast.success("Authenticator app connected — codes are now required at password sign-in");
      utils.profile.getMfaStatus.invalidate();
      setEnroll(null); setCode("");
      onClose();
      onConfirmed?.();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not confirm the code"),
  });

  // Mint a fresh secret each time the dialog opens.
  useEffect(() => {
    if (open && !enroll && !start.isPending) start.mutate();
    if (!open) { setEnroll(null); setCode(""); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupedSecret = enroll ? (enroll.secret.match(/.{1,4}/g) ?? []).join(" ") : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up authenticator app</DialogTitle>
          <DialogDescription>
            Add Velocity to Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app,
            then confirm with the 6-digit code it shows.
          </DialogDescription>
        </DialogHeader>
        {!enroll ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Setup key (enter manually in your app)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] tracking-wider break-all">
                  {groupedSecret}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  title="Copy setup key"
                  onClick={() => {
                    const w = navigator.clipboard?.writeText(enroll.secret);
                    if (w) w.then(() => toast.success("Setup key copied"), () => toast.error("Could not copy"));
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                On this device? <a href={enroll.otpauthUrl} className="font-medium text-foreground underline underline-offset-2">Open in authenticator app</a>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Verification code</Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ""))}
                className="tracking-widest"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                disabled={code.replace(/\s+/g, "").length !== 6 || confirm.isPending}
                onClick={() => confirm.mutate({ code: code.replace(/\s+/g, "") })}
                className="gap-1.5"
              >
                {confirm.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Verify &amp; connect
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
