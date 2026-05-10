/**
 * UnipileMailAdapter — implements EmailAdapter against Unipile's email API.
 *
 * Phase 1 STUB: every method throws a clear "not yet implemented" error so
 * the dispatch path is testable end-to-end without the API integration.
 *
 * Phase 2 will implement the actual calls:
 *   POST  /api/v1/emails                  → sendEmail (verified)
 *   GET   /api/v1/emails                  → listThreads (verified)
 *   GET   /api/v1/emails/{id}             → message details
 *   GET   /api/v1/accounts/{id}/folders   → listFolders
 *   PUT   /api/v1/emails/{id}/read        → markRead (TBD)
 *   DELETE /api/v1/emails/{id}            → moveToTrash (TBD)
 *
 * The account argument is the bridged sending_accounts row whose
 * `unipileAccountId` column points at the Unipile account UUID.
 */
import type { SendingAccount } from "../drizzle/schema";
import type {
  EmailAdapter,
  EmailFolder,
  EmailMessage,
  EmailThread,
  SendEmailInput,
} from "./emailAdapter";

const NOT_IMPL = (method: string) =>
  new Error(
    `UnipileMailAdapter.${method} is not yet implemented (Phase 2). ` +
      `The Unipile-bridged account is correctly routed; the API calls just ` +
      `aren't wired yet.`,
  );

export class UnipileMailAdapter implements EmailAdapter {
  private account: SendingAccount;
  // Cached for Phase 2 use; assigned in constructor for type safety.
  protected readonly unipileAccountId: string;

  constructor(account: SendingAccount) {
    this.account = account;
    if (!account.unipileAccountId) {
      throw new Error(
        "UnipileMailAdapter requires sending_accounts.unipileAccountId to be set",
      );
    }
    this.unipileAccountId = account.unipileAccountId;
  }

  /** Suppress unused-private warnings without erasing the field for Phase 2. */
  protected getAccount(): SendingAccount {
    return this.account;
  }

  async listFolders(): Promise<EmailFolder[]> {
    throw NOT_IMPL("listFolders");
  }

  async listThreads(): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    throw NOT_IMPL("listThreads");
  }

  async searchThreads(): Promise<{ threads: EmailThread[] }> {
    throw NOT_IMPL("searchThreads");
  }

  async getThread(): Promise<EmailMessage[]> {
    throw NOT_IMPL("getThread");
  }

  async getAttachment(): Promise<{ data: Buffer; contentType: string; filename: string }> {
    throw NOT_IMPL("getAttachment");
  }

  async sendEmail(_input: SendEmailInput): Promise<{ messageId: string; threadId?: string }> {
    throw NOT_IMPL("sendEmail");
  }

  async markRead(): Promise<void> {
    throw NOT_IMPL("markRead");
  }

  async moveToTrash(): Promise<void> {
    throw NOT_IMPL("moveToTrash");
  }

  async moveToFolder(): Promise<void> {
    throw NOT_IMPL("moveToFolder");
  }
}
