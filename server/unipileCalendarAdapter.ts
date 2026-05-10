/**
 * UnipileCalendarAdapter — implements CalendarAdapter against Unipile's
 * calendar API (replaces the dead CalDAV path for M365 accounts).
 *
 * Phase 1 STUB: every method throws a clear "not yet implemented" error so
 * the dispatch path is testable end-to-end without the API integration.
 *
 * Phase 3 will implement the actual calls (paths inferred from Unipile docs;
 * exact contracts to be verified against a live Microsoft account):
 *   GET    /api/v1/calendars                         → listCalendars
 *   GET    /api/v1/calendars/{id}/events             → listEvents
 *   POST   /api/v1/calendars/{id}/events             → createEvent
 *   PATCH  /api/v1/calendars/{cal}/events/{event}    → updateEvent
 *   DELETE /api/v1/calendars/{cal}/events/{event}    → deleteEvent
 */
import type { CalendarAccount } from "../drizzle/schema";
import type {
  CalendarAdapter,
  CalendarEventInput,
  CalendarEventResult,
  CalendarInfo,
} from "./calendarAdapter";

const NOT_IMPL = (method: string) =>
  new Error(
    `UnipileCalendarAdapter.${method} is not yet implemented (Phase 3). ` +
      `The Unipile-bridged account is correctly routed; the API calls just ` +
      `aren't wired yet.`,
  );

export class UnipileCalendarAdapter implements CalendarAdapter {
  private account: CalendarAccount;
  protected readonly unipileAccountId: string;

  constructor(account: CalendarAccount) {
    this.account = account;
    if (!account.unipileAccountId) {
      throw new Error(
        "UnipileCalendarAdapter requires calendar_accounts.unipileAccountId to be set",
      );
    }
    this.unipileAccountId = account.unipileAccountId;
  }

  protected getAccount(): CalendarAccount {
    return this.account;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    throw NOT_IMPL("listCalendars");
  }

  async listEvents(_calendarId: string, _from: Date, _to: Date): Promise<CalendarEventResult[]> {
    throw NOT_IMPL("listEvents");
  }

  async createEvent(_calendarId: string, _event: CalendarEventInput): Promise<CalendarEventResult> {
    throw NOT_IMPL("createEvent");
  }

  async updateEvent(
    _calendarId: string,
    _externalId: string,
    _event: Partial<CalendarEventInput>,
  ): Promise<CalendarEventResult> {
    throw NOT_IMPL("updateEvent");
  }

  async deleteEvent(_calendarId: string, _externalId: string): Promise<void> {
    throw NOT_IMPL("deleteEvent");
  }
}
