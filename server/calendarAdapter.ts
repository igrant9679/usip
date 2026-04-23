/**
 * calendarAdapter.ts — Unified calendar adapter for Rep Calendar (Feature 73)
 *
 * GoogleCalendarAdapter : Google Calendar via googleapis
 * CalDAVAdapter         : Outlook Calendar, Apple Calendar, generic CalDAV via tsdav
 */

import { google } from "googleapis";
import { createDAVClient } from "tsdav";
import type { CalendarAccount } from "../drizzle/schema";
import { decryptField } from "./emailAdapter";

/* ─── Shared types ───────────────────────────────────────────────────────── */

export interface CalendarEventInput {
  title: string;
  description?: string;
  location?: string;
  meetingUrl?: string;
  startAt: Date;
  endAt: Date;
  allDay?: boolean;
  attendees?: Array<{ email: string; name?: string }>;
}

export interface CalendarEventResult {
  externalId: string;
  title: string;
  description?: string;
  location?: string;
  meetingUrl?: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  attendees: Array<{ email: string; name?: string; responseStatus?: string }>;
}

export interface CalendarInfo {
  id: string;
  name: string;
  description?: string;
  color?: string;
  primary?: boolean;
}

export interface CalendarAdapter {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(calendarId: string, from: Date, to: Date): Promise<CalendarEventResult[]>;
  createEvent(calendarId: string, event: CalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(calendarId: string, externalId: string, event: Partial<CalendarEventInput>): Promise<CalendarEventResult>;
  deleteEvent(calendarId: string, externalId: string): Promise<void>;
}

/* ─── Google Calendar Adapter ────────────────────────────────────────────── */

export class GoogleCalendarAdapter implements CalendarAdapter {
  private calendar: ReturnType<typeof google.calendar>;

  constructor(account: CalendarAccount) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      access_token: account.oauthAccessToken,
      refresh_token: account.oauthRefreshToken,
      expiry_date: account.oauthTokenExpiry ? new Date(account.oauthTokenExpiry).getTime() : undefined,
    });
    this.calendar = google.calendar({ version: "v3", auth: oauth2Client });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await this.calendar.calendarList.list();
    return (res.data.items ?? []).map((c) => ({
      id: c.id ?? "",
      name: c.summary ?? "",
      description: c.description ?? undefined,
      color: c.backgroundColor ?? undefined,
      primary: c.primary ?? false,
    }));
  }

  async listEvents(calendarId: string, from: Date, to: Date): Promise<CalendarEventResult[]> {
    const res = await this.calendar.events.list({
      calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 500,
    });
    return (res.data.items ?? []).map((e) => this._mapEvent(e));
  }

  async createEvent(calendarId: string, event: CalendarEventInput): Promise<CalendarEventResult> {
    const res = await this.calendar.events.insert({
      calendarId,
      requestBody: this._toGoogleEvent(event),
    });
    return this._mapEvent(res.data);
  }

  async updateEvent(calendarId: string, externalId: string, event: Partial<CalendarEventInput>): Promise<CalendarEventResult> {
    const res = await this.calendar.events.patch({
      calendarId,
      eventId: externalId,
      requestBody: this._toGoogleEvent(event as CalendarEventInput),
    });
    return this._mapEvent(res.data);
  }

  async deleteEvent(calendarId: string, externalId: string): Promise<void> {
    await this.calendar.events.delete({ calendarId, eventId: externalId });
  }

  private _toGoogleEvent(event: Partial<CalendarEventInput>): any {
    const body: any = {};
    if (event.title) body.summary = event.title;
    if (event.description) body.description = event.description;
    if (event.location) body.location = event.location;
    if (event.startAt) {
      body.start = event.allDay
        ? { date: event.startAt.toISOString().split("T")[0] }
        : { dateTime: event.startAt.toISOString() };
    }
    if (event.endAt) {
      body.end = event.allDay
        ? { date: event.endAt.toISOString().split("T")[0] }
        : { dateTime: event.endAt.toISOString() };
    }
    if (event.attendees) {
      body.attendees = event.attendees.map((a) => ({ email: a.email, displayName: a.name }));
    }
    if (event.meetingUrl) {
      body.description = (body.description ? body.description + "\n\n" : "") + `Meeting URL: ${event.meetingUrl}`;
    }
    return body;
  }

  private _mapEvent(e: any): CalendarEventResult {
    const startRaw = e.start?.dateTime ?? e.start?.date ?? "";
    const endRaw = e.end?.dateTime ?? e.end?.date ?? "";
    const allDay = !e.start?.dateTime;
    return {
      externalId: e.id ?? "",
      title: e.summary ?? "(no title)",
      description: e.description ?? undefined,
      location: e.location ?? undefined,
      meetingUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.[0]?.uri ?? undefined,
      startAt: new Date(startRaw),
      endAt: new Date(endRaw),
      allDay,
      attendees: (e.attendees ?? []).map((a: any) => ({
        email: a.email ?? "", name: a.displayName ?? undefined, responseStatus: a.responseStatus ?? undefined,
      })),
    };
  }
}

/* ─── CalDAV Adapter (Outlook, Apple, generic) ───────────────────────────── */

export class CalDAVAdapter implements CalendarAdapter {
  private account: CalendarAccount;

  constructor(account: CalendarAccount) {
    this.account = account;
  }

  private async getClient() {
    const acc = this.account;
    if (!acc.caldavUrl || !acc.caldavUsername || !acc.caldavPassword) {
      throw new Error("CalDAV not configured for this account");
    }
    let password: string;
    try { password = decryptField(acc.caldavPassword); } catch { password = acc.caldavPassword; }

    const serverUrl = acc.caldavUrl;
    const authMethod = acc.provider === "outlook_caldav" ? "Basic" : "Basic";

    const client = await createDAVClient({
      serverUrl,
      credentials: { username: acc.caldavUsername, password },
      authMethod,
      defaultAccountType: "caldav",
    });
    return client;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const client = await this.getClient();
    const calendars = await client.fetchCalendars();
    return calendars.map((c) => ({
      id: c.url,
      name: c.displayName ?? "Calendar",
      description: c.description ?? undefined,
      color: (c as any).calendarColor ?? undefined,
      primary: false,
    }));
  }

  async listEvents(calendarId: string, from: Date, to: Date): Promise<CalendarEventResult[]> {
    const client = await this.getClient();
    const objects = await client.fetchCalendarObjects({
      calendar: { url: calendarId },
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
    return objects.map((obj) => this._parseICS(obj.data ?? "", obj.url)).filter(Boolean) as CalendarEventResult[];
  }

  async createEvent(calendarId: string, event: CalendarEventInput): Promise<CalendarEventResult> {
    const client = await this.getClient();
    const uid = `usip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ics = this._buildICS(uid, event);
    await client.createCalendarObject({
      calendar: { url: calendarId },
      filename: `${uid}.ics`,
      iCalString: ics,
    });
    return {
      externalId: uid,
      title: event.title,
      description: event.description,
      location: event.location,
      meetingUrl: event.meetingUrl,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay ?? false,
      attendees: event.attendees ?? [],
    };
  }

  async updateEvent(calendarId: string, externalId: string, event: Partial<CalendarEventInput>): Promise<CalendarEventResult> {
    const client = await this.getClient();
    const ics = this._buildICS(externalId, event as CalendarEventInput);
    await client.updateCalendarObject({
      calendarObject: { url: `${calendarId}${externalId}.ics`, data: ics, etag: "" },
    });
    return {
      externalId,
      title: event.title ?? "",
      description: event.description,
      location: event.location,
      meetingUrl: event.meetingUrl,
      startAt: event.startAt ?? new Date(),
      endAt: event.endAt ?? new Date(),
      allDay: event.allDay ?? false,
      attendees: event.attendees ?? [],
    };
  }

  async deleteEvent(calendarId: string, externalId: string): Promise<void> {
    const client = await this.getClient();
    await client.deleteCalendarObject({
      calendarObject: { url: `${calendarId}${externalId}.ics`, etag: "" },
    });
  }

  private _buildICS(uid: string, event: CalendarEventInput): string {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//USIP//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${fmt(new Date())}`,
      `DTSTART:${fmt(event.startAt)}`,
      `DTEND:${fmt(event.endAt)}`,
      `SUMMARY:${event.title}`,
    ];
    if (event.description) lines.push(`DESCRIPTION:${event.description.replace(/\n/g, "\\n")}`);
    if (event.location) lines.push(`LOCATION:${event.location}`);
    for (const att of event.attendees ?? []) {
      lines.push(`ATTENDEE;CN=${att.name ?? att.email}:mailto:${att.email}`);
    }
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  private _parseICS(ics: string, url: string): CalendarEventResult | null {
    try {
      const get = (key: string) => {
        const m = ics.match(new RegExp(`^${key}[;:](.+)$`, "m"));
        return m?.[1]?.trim() ?? "";
      };
      const uid = get("UID") || url;
      const summary = get("SUMMARY") || "(no title)";
      const dtstart = get("DTSTART");
      const dtend = get("DTEND");
      const desc = get("DESCRIPTION").replace(/\\n/g, "\n");
      const loc = get("LOCATION");
      const parseDate = (s: string) => {
        if (!s) return new Date();
        const clean = s.replace(/Z$/, "").replace(/T/, "T");
        if (clean.length === 8) return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
        return new Date(s.endsWith("Z") ? s : s + "Z");
      };
      return {
        externalId: uid, title: summary,
        description: desc || undefined, location: loc || undefined,
        startAt: parseDate(dtstart), endAt: parseDate(dtend),
        allDay: !dtstart.includes("T"), attendees: [],
      };
    } catch { return null; }
  }
}

/* ─── Factory ────────────────────────────────────────────────────────────── */

export function createCalendarAdapter(account: CalendarAccount): CalendarAdapter {
  if (account.provider === "google") return new GoogleCalendarAdapter(account);
  return new CalDAVAdapter(account);
}
