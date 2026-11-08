/**
 * A freshly made set of 2FA backup codes, shown once (audit 2026-10-20, G15).
 *
 * The server keeps only their hashes, so this is the person's one chance to
 * copy them. Used by the setup dialog (codes come with the authenticator) and
 * by "Make new backup codes" on the security screen.
 */
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Copy, Download } from "lucide-react";

export function BackupCodesPanel({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each code signs you in once, in place of an authenticator code, if you lose your phone.
        Keep them somewhere safe: this is the only time they are shown.
      </p>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-[13px] tracking-wider" aria-label="Backup codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            const w = navigator.clipboard?.writeText(text);
            if (w) w.then(() => toast.success("Backup codes copied"), () => toast.error("Could not copy"));
          }}
        >
          <Copy className="size-3.5" /> Copy all
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            const blob = new Blob([`Velocity backup codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "velocity-backup-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="size-3.5" /> Download
        </Button>
      </div>
    </div>
  );
}
