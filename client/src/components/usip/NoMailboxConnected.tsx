/**
 * The Mailbox's "nothing connected" note, in its own file so tests render it.
 */
import { Link } from "wouter";

/**
 * What My Mailbox needs and where to get it (tracker 2026-11-06, items 1 and
 * 5: "could not compose an e-mail", "can't be tested without a connected
 * mailbox"). The list is the Microsoft 365 / Outlook mailboxes connected on
 * Connected Accounts, nothing else — but with none, Compose was disabled with
 * no reason given and the text said "Configure IMAP in Sending Accounts",
 * which never adds a mailbox here. Exported for the tests.
 */
export function NoMailboxConnected({ viewingRep }: { viewingRep: boolean }) {
  if (viewingRep) {
    return <p className="text-xs text-muted-foreground px-2 py-2">This rep hasn't connected a mailbox yet.</p>;
  }
  return (
    <div className="px-2 py-2 space-y-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">No mailbox connected</p>
      <p>
        My Mailbox shows your Microsoft 365 / Outlook mailbox. Connect it on Connected Accounts
        (Connect Account → Outlook); once it is connected it is listed here and Compose turns on.
      </p>
      <p>Mailboxes added under Sending Accounts send campaign and sequence mail; they are not listed here.</p>
      <Link href="/connected-accounts" className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">
        Connect a mailbox
      </Link>
    </div>
  );
}
