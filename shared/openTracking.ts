/**
 * openTracking.ts — telling a person opening an email from a machine fetching
 * an image.
 *
 * An open pixel does not measure opens. It measures IMAGE FETCHES, and most of
 * them are not people:
 *
 *   • **Apple Mail Privacy Protection** fetches every remote image the moment
 *     a message is DELIVERED, through Apple's relays, for every Apple Mail user
 *     with the default setting. The recipient may never look at the message.
 *   • **Corporate mail security** (Proofpoint, Mimecast, Barracuda, Microsoft
 *     Defender/Safe Links) fetches everything in a message to scan it, also at
 *     delivery time.
 *   • **Link previewers** (Slack, Teams, social unfurlers) fetch when a message
 *     is forwarded somewhere else entirely.
 *
 * All three produce a hit within seconds of the send, which is the tell this
 * module leans on hardest: a human has not even seen the notification yet.
 *
 * What is NOT filtered: Gmail's `GoogleImageProxy` and Yahoo's proxy fetch when
 * the user actually DISPLAYS the message, so they are genuine opens seen
 * through a proxy. Treating them as machines would delete most real Gmail
 * opens — the opposite error, and a bigger one.
 *
 * Used by both open paths (email_drafts and are_execution_queue) so the two
 * cannot drift into disagreeing about what an open is.
 */

/** A hit is a machine fetch until proven otherwise by these signals. */
export interface OpenSignal {
  /** Request User-Agent, if any. */
  userAgent?: string | null;
  /** HTTP method. HEAD is a probe, never a person. */
  method?: string | null;
  /** Milliseconds between the send and this fetch. Null when unknown. */
  msSinceSend?: number | null;
  /** Milliseconds since the last hit on the same message. Null when first. */
  msSinceLastOpen?: number | null;
}

export interface OpenVerdict {
  machine: boolean;
  /** Short slug naming WHY, stored on the event so the call is auditable. */
  reason: string | null;
}

/**
 * Hits inside this window after the send are prefetch, not reading.
 *
 * 15s is deliberately conservative. Apple MPP and scanners land in the first
 * 1–5 seconds; a human who genuinely opens within 15 seconds of receiving a
 * cold email is rare enough that counting them is the cheaper error than
 * counting every MPP recipient as engaged.
 */
export const PREFETCH_WINDOW_MS = 15_000;

/** Two hits closer together than this are one fetch storm, not two opens. */
export const DEDUPE_WINDOW_MS = 2_000;

/**
 * Substrings that identify a fetch as automated. Matched case-insensitively
 * against the User-Agent.
 *
 * Deliberately excludes the mail-proxy fetchers that indicate a real display
 * (see the module note). Ordered roughly by how often they are seen.
 */
export const MACHINE_USER_AGENTS: readonly string[] = [
  // Mail security / scanning
  "proofpoint", "mimecast", "barracuda", "symantec", "messagelabs", "cloudmark",
  "forcepoint", "spamtitan", "trend micro", "trendmicro", "fireeye", "sophos",
  "ironport", "zscaler", "netskope", "safelinks", "bingpreview",
  // Link unfurlers
  "slackbot", "slack-imgproxy", "skypeuripreview", "facebookexternalhit",
  "twitterbot", "linkedinbot", "whatsapp", "telegrambot", "discordbot",
  "embedly", "quora link preview", "outbrain", "pinterest",
  // Scripted clients
  "curl/", "wget", "python-requests", "python-urllib", "go-http-client",
  "java/", "okhttp", "axios/", "node-fetch", "libwww-perl", "httpclient",
  "postmanruntime", "insomnia", "guzzlehttp",
  // Headless browsers and generic automation
  "headlesschrome", "phantomjs", "puppeteer", "playwright", "selenium",
  "lighthouse", "pingdom", "uptimerobot", "statuscake", "site24x7",
];

/** Generic tokens, matched on a word boundary to avoid eating real UAs. */
const GENERIC_MACHINE_TOKENS = ["bot", "crawler", "spider", "scanner", "fetcher", "monitor", "preview"];

/**
 * Proxies that fetch when a HUMAN displays the message. Explicitly allowed
 * past the generic-token rule below — "GoogleImageProxy" contains no bot token
 * today, but this states the intent rather than relying on that.
 */
export const HUMAN_PROXY_USER_AGENTS: readonly string[] = [
  "googleimageproxy", "ggpht.com", "yahoomailproxy", "yimg.com",
];

export function isHumanProxy(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return false;
  return HUMAN_PROXY_USER_AGENTS.some((p) => ua.includes(p));
}

/**
 * Classify one pixel hit.
 *
 * Order matters: the cheapest and most certain signals first, and the human
 * proxies short-circuit before any pattern matching can misfire on them.
 */
export function classifyOpen(signal: OpenSignal): OpenVerdict {
  const method = (signal.method ?? "GET").toUpperCase();
  if (method === "HEAD" || method === "OPTIONS") {
    // Express routes HEAD to the GET handler, so a scanner's HEAD probe used
    // to count as an open without ever loading the image.
    return { machine: true, reason: "head_probe" };
  }

  const ua = (signal.userAgent ?? "").trim();
  const lower = ua.toLowerCase();

  if (!ua) {
    // Every real mail client and image proxy sends one.
    return { machine: true, reason: "no_user_agent" };
  }

  const human = isHumanProxy(lower);

  if (!human) {
    for (const needle of MACHINE_USER_AGENTS) {
      if (lower.includes(needle)) return { machine: true, reason: "known_scanner" };
    }
    for (const token of GENERIC_MACHINE_TOKENS) {
      if (new RegExp(`\\b${token}\\b`).test(lower)) return { machine: true, reason: "bot_user_agent" };
    }
  }

  // Duplicate fetch of the same message, milliseconds apart — one storm.
  if (signal.msSinceLastOpen != null && signal.msSinceLastOpen >= 0 && signal.msSinceLastOpen < DEDUPE_WINDOW_MS) {
    return { machine: true, reason: "duplicate_fetch" };
  }

  /**
   * The prefetch window. This is the rule that catches Apple Mail Privacy
   * Protection, which presents an ordinary-looking Safari User-Agent and
   * cannot be identified any other way from here.
   *
   * Applies to human proxies too: Gmail displaying a message two seconds after
   * it was sent is a prefetch, not a read.
   */
  if (signal.msSinceSend != null && signal.msSinceSend >= 0 && signal.msSinceSend < PREFETCH_WINDOW_MS) {
    return { machine: true, reason: "prefetch_window" };
  }

  return { machine: false, reason: null };
}

/** Human-readable label for a stored reason slug. */
export const OPEN_MACHINE_REASONS: Record<string, string> = {
  head_probe: "A scanner probed the pixel without loading it",
  no_user_agent: "Fetched with no user agent — not a mail client",
  known_scanner: "Fetched by a mail-security scanner or link previewer",
  bot_user_agent: "Fetched by an automated client",
  duplicate_fetch: "Repeat fetch of the same message within two seconds",
  prefetch_window: "Fetched within 15s of sending — image prefetch, not a read",
};
