/**
 * Calendar.tsx — Rep Calendar UI (Feature 73)
 *
 * Providers: Google Calendar (OAuth), Outlook/Apple (CalDAV)
 * Views: Month, Week, Day, Agenda
 * Manager access: managers can select a rep to view their calendar
 */

import { useState, useRef, useCallback, useMemo } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CalendarDays, Plus, RefreshCw, Settings, Loader2, Users, Trash2, Link2, Sparkles, ArrowUpRight
} from "lucide-react";
import { Streamdown } from "streamdown";

// ─── Connect Calendar Dialog ───────────────────────────────────────────────────

type CalendarProvider = "google" | "outlook_oauth" | "outlook_caldav" | "apple_caldav" | "generic_caldav";

function ConnectCalendarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [provider, setProvider] = useState<CalendarProvider>("google");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  // CalDAV fields
  const [caldavUrl, setCaldavUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // OAuth token fields (Google + Outlook OAuth)
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [calendarId, setCalendarId] = useState("primary");

  const connectCalDAV = trpc.calendar.connectCalDAV.useMutation({
    onSuccess: () => { toast.success("Calendar connected"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const connectGoogle = trpc.calendar.connectGoogle.useMutation({
    onSuccess: () => { toast.success("Google Calendar connected"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const connectOutlookOAuth = trpc.calendar.connectOutlookOAuth.useMutation({
    onSuccess: () => { toast.success("Outlook Calendar connected"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const providerUrls: Record<string, string> = {
    outlook_caldav: "https://outlook.office365.com/owa/calendar/",
    apple_caldav: "https://caldav.icloud.com/",
    generic_caldav: "",
  };

  const isOAuth = provider === "google" || provider === "outlook_oauth";
  const isCalDAV = !isOAuth;
  const isPending = connectCalDAV.isPending || connectGoogle.isPending || connectOutlookOAuth.isPending;

  function handleConnect() {
    if (isOAuth) {
      if (!accessToken.trim() || !refreshToken.trim()) {
        toast.error("Access token and refresh token are required");
        return;
      }
      if (provider === "google") {
        connectGoogle.mutate({ label: label || undefined, email: email || undefined, oauthAccessToken: accessToken, oauthRefreshToken: refreshToken, calendarId: calendarId || "primary" });
      } else {
        connectOutlookOAuth.mutate({ label: label || undefined, email: email || undefined, oauthAccessToken: accessToken, oauthRefreshToken: refreshToken, calendarId: calendarId || "primary" });
      }
    } else {
      if (!caldavUrl.trim() || !username.trim() || !password.trim()) {
        toast.error("CalDAV URL, username, and password are required");
        return;
      }
      connectCalDAV.mutate({ provider: provider as any, label: label || undefined, email: email || undefined, caldavUrl, caldavUsername: username, caldavPassword: password });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Calendar Account</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v: CalendarProvider) => { setProvider(v); if (!isOAuth) setCaldavUrl(providerUrls[v] ?? ""); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google Calendar (OAuth)</SelectItem>
                <SelectItem value="outlook_oauth">Microsoft 365 / Outlook (OAuth)</SelectItem>
                <SelectItem value="outlook_caldav">Microsoft Outlook (CalDAV)</SelectItem>
                <SelectItem value="apple_caldav">Apple Calendar (iCloud CalDAV)</SelectItem>
                <SelectItem value="generic_caldav">Generic CalDAV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work Calendar" />
          </div>
          <div className="space-y-1">
            <Label>Email (optional)</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>

          {isOAuth && (
            <>
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
                {provider === "google" ? (
                  <p>Obtain tokens from the <strong>Google OAuth 2.0 Playground</strong> (oauth2.googleapis.com/tokeninfo) or your Google Cloud Console app. Required scope: <code>https://www.googleapis.com/auth/calendar</code></p>
                ) : (
                  <p>Obtain tokens from the <strong>Microsoft Azure Portal</strong> (portal.azure.com) or Microsoft OAuth 2.0 Playground. Required scope: <code>Calendars.ReadWrite offline_access</code></p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Access Token</Label>
                <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="ya29.a0AfH6SMB..." />
              </div>
              <div className="space-y-1">
                <Label>Refresh Token</Label>
                <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="1//0gLd..." />
              </div>
              <div className="space-y-1">
                <Label>Calendar ID (optional)</Label>
                <Input value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="primary" />
                <p className="text-xs text-muted-foreground">Use &quot;primary&quot; for the default calendar, or a specific calendar ID from your provider.</p>
              </div>
            </>
          )}

          {isCalDAV && (
            <>
              <div className="space-y-1">
                <Label>CalDAV URL</Label>
                <Input value={caldavUrl} onChange={(e) => setCaldavUrl(e.target.value)} placeholder="https://..." />
                {provider === "outlook_caldav" && (
                  <p className="text-xs text-muted-foreground">Outlook Web App → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS/CalDAV URL</p>
                )}
                {provider === "apple_caldav" && (
                  <p className="text-xs text-muted-foreground">Use an app-specific password from appleid.apple.com</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Username</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="your@email.com" />
              </div>
              <div className="space-y-1">
                <Label>Password / App Password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConnect} disabled={isPending}>
            {isPending && <Loader2 className="size-4 animate-spin mr-2" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Event Dialog ──────────────────────────────────────────────────────────────

function EventDialog({
  open, onClose, accountId, calendarId, initialStart, initialEnd, event
}: {
  open: boolean;
  onClose: () => void;
  accountId: number;
  calendarId: string;
  initialStart?: Date;
  initialEnd?: Date;
  event?: any;
}) {
  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [meetingUrl, setMeetingUrl] = useState(event?.meetingUrl ?? "");
  const [start, setStart] = useState<string>(
    (event?.startAt ?? initialStart ?? new Date()).toISOString().slice(0, 16)
  );
  const [end, setEnd] = useState<string>(
    (event?.endAt ?? initialEnd ?? new Date(Date.now() + 3600_000)).toISOString().slice(0, 16)
  );
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [attendees, setAttendees] = useState<string>(
    event?.attendees ? JSON.parse(event.attendees).map((a: any) => a.email).join(", ") : ""
  );

  const [aiSummary, setAiSummary] = useState<string | null>(event?.aiSummary ?? null);

  const createEvent = trpc.calendar.createEvent.useMutation({
    onSuccess: () => { toast.success("Event created"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const updateEvent = trpc.calendar.updateEvent.useMutation({
    onSuccess: () => { toast.success("Event updated"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteEvent = trpc.calendar.deleteEvent.useMutation({
    onSuccess: () => { toast.success("Event deleted"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const [showOppPicker, setShowOppPicker] = useState(false);
  const [selectedOppId, setSelectedOppId] = useState<number | null>(null);
  const { data: opportunitiesList = [] } = trpc.opportunities.list.useQuery(
    { limit: 100 },
    { enabled: showOppPicker }
  );
  const summarizeMeeting = trpc.calendar.summarizeMeeting.useMutation({
    onSuccess: (data) => { setAiSummary(data.summary); toast.success("Meeting summary generated"); },
    onError: (e) => toast.error(e.message),
  });
  const pushSummary = trpc.calendar.pushSummaryToOpportunity.useMutation({
    onSuccess: (data) => {
      toast.success(`Summary pushed to "${data.opportunityName}"`);
      setShowOppPicker(false);
      setSelectedOppId(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const isLoading = createEvent.isPending || updateEvent.isPending || deleteEvent.isPending;

  function parseAttendees() {
    return attendees.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
  }

  function handleSave() {
    if (!title.trim()) { toast.error("Title is required"); return; }
    const payload = {
      accountId, calendarId, title, description: description || undefined,
      location: location || undefined, meetingUrl: meetingUrl || undefined,
      startAt: new Date(start), endAt: new Date(end), allDay,
      attendees: parseAttendees().length ? parseAttendees() : undefined,
    };
    if (event) {
      updateEvent.mutate({ ...payload, externalId: event.externalId, dbId: event.id });
    } else {
      createEvent.mutate(payload);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{event ? "Edit Event" : "New Event"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label>Title *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Start</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={allDay} />
            </div>
            <div className="space-y-1">
              <Label>End</Label>
              <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} disabled={allDay} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={allDay} onCheckedChange={setAllDay} id="allday" />
            <Label htmlFor="allday">All day</Label>
          </div>
          <div className="space-y-1">
            <Label>Location</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Conference room, address…" />
          </div>
          <div className="space-y-1">
            <Label>Meeting URL</Label>
            <Input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/…" />
          </div>
          <div className="space-y-1">
            <Label>Attendees (comma-separated emails)</Label>
            <Input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="alice@co.com, bob@co.com" />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>

          {/* AI Meeting Summary panel — only shown for existing events */}
          {event?.id && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5"><Sparkles className="size-3.5 text-violet-500" /> AI Meeting Summary</Label>
                <Button
                  variant="outline" size="sm"
                  onClick={() => summarizeMeeting.mutate({ eventId: event.id })}
                  disabled={summarizeMeeting.isPending}
                >
                  {summarizeMeeting.isPending ? <><Loader2 className="size-3.5 animate-spin mr-1" />Generating…</> : <><Sparkles className="size-3.5 mr-1" />{aiSummary ? "Re-summarize" : "Summarize"}</>}
                </Button>
              </div>
              {aiSummary && (
                <div className="space-y-2">
                  <div className="rounded-md border bg-muted/40 p-3 text-sm max-h-48 overflow-y-auto">
                    <Streamdown>{aiSummary}</Streamdown>
                  </div>
                  {!showOppPicker ? (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => setShowOppPicker(true)}>
                      <ArrowUpRight className="size-3.5 mr-1" /> Push to Opportunity
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Select
                        value={selectedOppId ? String(selectedOppId) : ""}
                        onValueChange={(v) => setSelectedOppId(Number(v))}
                      >
                        <SelectTrigger className="flex-1 text-xs h-8">
                          <SelectValue placeholder="Select opportunity…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(opportunitiesList as any[]).map((opp: any) => (
                            <SelectItem key={opp.id} value={String(opp.id)}>
                              {opp.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        disabled={!selectedOppId || pushSummary.isPending}
                        onClick={() => selectedOppId && pushSummary.mutate({ eventId: event!.id, opportunityId: selectedOppId })}
                      >
                        {pushSummary.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Push"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowOppPicker(false)}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          {event && (
            <Button variant="destructive" size="sm"
              onClick={() => deleteEvent.mutate({ accountId, calendarId, externalId: event.externalId, dbId: event.id })}
              disabled={isLoading}
            >
              <Trash2 className="size-3.5 mr-1" /> Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading && <Loader2 className="size-4 animate-spin mr-2" />}
            {event ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const { user } = useAuth();
  const calendarRef = useRef<FullCalendar>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>("primary");
  const [editingEvent, setEditingEvent] = useState<any>(null);
  const [newEventStart, setNewEventStart] = useState<Date | undefined>();
  const [newEventEnd, setNewEventEnd] = useState<Date | undefined>();
  const [repUserId, setRepUserId] = useState<number | undefined>();
  const [dateRange, setDateRange] = useState<{ from: Date; to: Date }>(() => {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: new Date(now.getFullYear(), now.getMonth() + 2, 0),
    };
  });

  const { data: accounts, isLoading: accountsLoading, refetch: refetchAccounts } = trpc.calendar.listAccounts.useQuery(
    { repUserId },
    { enabled: true }
  );
  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } = trpc.calendar.listEvents.useQuery(
    { from: dateRange.from, to: dateRange.to, repUserId, accountId: selectedAccountId ?? undefined },
    { enabled: true }
  );
  const { data: teamData } = trpc.team.list.useQuery(undefined, { enabled: true });
  const syncEvents = trpc.calendar.syncEvents.useMutation({
    onSuccess: (d) => { toast.success(`Synced ${d.synced} events`); refetchEvents(); },
    onError: (e) => toast.error(e.message),
  });
  const disconnectAccount = trpc.calendar.disconnectAccount.useMutation({
    onSuccess: () => { toast.success("Calendar disconnected"); refetchAccounts(); },
    onError: (e) => toast.error(e.message),
  });

  const isManager = (user as any)?.role === "manager" || (user as any)?.role === "admin" || (user as any)?.role === "super_admin";

  // Map DB events to FullCalendar format
  const fcEvents = useMemo(() => {
    if (!events) return [];
    return events.map((e: any) => ({
      id: String(e.id),
      title: e.title,
      start: new Date(e.startAt),
      end: new Date(e.endAt),
      allDay: e.allDay,
      extendedProps: e,
      backgroundColor: e.relatedType === "contact" ? "#3b82f6" : e.relatedType === "opportunity" ? "#10b981" : undefined,
    }));
  }, [events]);

  const handleDateSet = useCallback((info: any) => {
    setDateRange({ from: info.start, to: info.end });
  }, []);

  const handleDateClick = useCallback((info: any) => {
    setEditingEvent(null);
    setNewEventStart(info.date);
    setNewEventEnd(new Date(info.date.getTime() + 3600_000));
    setEventDialogOpen(true);
  }, []);

  const handleEventClick = useCallback((info: any) => {
    setEditingEvent(info.event.extendedProps);
    setNewEventStart(undefined);
    setNewEventEnd(undefined);
    setEventDialogOpen(true);
  }, []);

  const handleSync = () => {
    if (!selectedAccountId) { toast.error("Select an account to sync"); return; }
    syncEvents.mutate({ accountId: selectedAccountId, from: dateRange.from, to: dateRange.to });
  };

  return (
    <Shell title="My Calendar">
      <PageHeader title="My Calendar" description="Schedule and manage meetings, calls, and follow-ups across your pipeline." pageKey="calendar" 
        icon={<CalendarDays className="size-5" />}
      />
      <div className="h-[calc(100vh-8.5rem)] flex overflow-hidden">
        {/* Left panel */}
        <div className="w-56 shrink-0 border-r bg-muted/20 flex flex-col overflow-hidden">
          <div className="p-3 border-b space-y-2">
            <Button
              size="sm"
              className="w-full"
              onClick={() => { setEditingEvent(null); setNewEventStart(new Date()); setNewEventEnd(new Date(Date.now() + 3600_000)); setEventDialogOpen(true); }}
              disabled={!selectedAccountId}
            >
              <Plus className="size-3.5 mr-2" /> New Event
            </Button>

            {/* Manager rep selector */}
            {isManager && teamData?.members?.length && (
              <Select
                value={repUserId?.toString() ?? "me"}
                onValueChange={(v) => {
                  setRepUserId(v === "me" ? undefined : Number(v));
                  setSelectedAccountId(null);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <Users className="size-3 mr-1" />
                  <SelectValue placeholder="View rep…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">My Calendar</SelectItem>
                  {teamData.members.map((m: any) => (
                    <SelectItem key={m.userId} value={m.userId.toString()}>
                      {m.name ?? m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Calendar accounts */}
          <div className="flex-1 overflow-y-auto p-2">
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Calendars</span>
              {!repUserId && (
                <Button variant="ghost" size="icon" className="size-5" onClick={() => setConnectOpen(true)} title="Connect calendar">
                  <Plus className="size-3" />
                </Button>
              )}
            </div>
            {accountsLoading ? (
              <div className="flex justify-center py-2"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
            ) : accounts?.length ? (
              accounts.map((acc: any) => (
                <div
                  key={acc.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors group",
                    selectedAccountId === acc.id ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                  )}
                  onClick={() => setSelectedAccountId(acc.id)}
                >
                  <CalendarDays className="size-3 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{acc.label ?? acc.email ?? acc.provider}</div>
                    <div className="text-[10px] opacity-60">{acc.provider.replace("_caldav", "")}</div>
                  </div>
                  {!repUserId && (
                    <button
                      className="opacity-0 group-hover:opacity-100 hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); disconnectAccount.mutate({ accountId: acc.id }); }}
                      title="Disconnect"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No calendars connected.
                {!repUserId && (
                  <button className="text-primary underline ml-1" onClick={() => setConnectOpen(true)}>Connect one</button>
                )}
              </div>
            )}
          </div>

          {/* Sync button */}
          {selectedAccountId && !repUserId && (
            <div className="p-2 border-t">
              <Button variant="outline" size="sm" className="w-full" onClick={handleSync} disabled={syncEvents.isPending}>
                {syncEvents.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <RefreshCw className="size-3.5 mr-1" />}
                Sync Events
              </Button>
            </div>
          )}
        </div>

        {/* Calendar */}
        <div className="flex-1 overflow-hidden p-4">
          {eventsLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {accounts?.length === 0 && !accountsLoading ? (
            <EmptyState
              icon={CalendarDays}
              title="No calendar connected"
              description="Connect a Google, Outlook, or Apple calendar to view and manage your events here."
              action={
                !repUserId ? (
                  <Button onClick={() => setConnectOpen(true)}>
                    <Plus className="size-4 mr-2" /> Connect Calendar
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
              initialView="timeGridWeek"
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek",
              }}
              events={fcEvents}
              editable={!repUserId}
              selectable={!repUserId}
              selectMirror
              dayMaxEvents
              weekends
              datesSet={handleDateSet}
              dateClick={!repUserId ? handleDateClick : undefined}
              eventClick={handleEventClick}
              height="100%"
              eventTimeFormat={{ hour: "2-digit", minute: "2-digit", meridiem: "short" }}
              slotMinTime="06:00:00"
              slotMaxTime="22:00:00"
              nowIndicator
              businessHours={{ daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00" }}
            />
          )}
        </div>
      </div>

      {/* Connect calendar dialog */}
      <ConnectCalendarDialog open={connectOpen} onClose={() => { setConnectOpen(false); refetchAccounts(); }} />

      {/* Event create/edit dialog */}
      {eventDialogOpen && selectedAccountId && (
        <EventDialog
          open={eventDialogOpen}
          onClose={() => { setEventDialogOpen(false); setEditingEvent(null); refetchEvents(); }}
          accountId={selectedAccountId}
          calendarId={selectedCalendarId}
          initialStart={newEventStart}
          initialEnd={newEventEnd}
          event={editingEvent}
        />
      )}
    </Shell>
  );
}
