/**
 * "Chrome on Windows" from a User-Agent header, for the active-sessions list
 * (audit 2026-10-20, F3). Deliberately coarse: a person needs to recognise
 * their own laptop and phone, not read a version string. PURE.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  const s = String(ua ?? "");
  if (!s.trim()) return "Unknown device";
  // Order matters: Edge and Opera say "Chrome" too, and Chrome says "Safari".
  const browser =
    /Edg(?:e|A|iOS)?\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /Chrome\/|CriOS\//.test(s) ? "Chrome"
    : /Safari\//.test(s) && /Version\//.test(s) ? "Safari"
    : /curl\/|node-fetch|undici|python-requests|axios/i.test(s) ? "Script"
    : "Browser";
  const os =
    /iPhone/.test(s) ? "iPhone"
    : /iPad/.test(s) ? "iPad"
    : /Android/.test(s) ? "Android"
    : /Windows/.test(s) ? "Windows"
    : /Mac OS X|Macintosh/.test(s) ? "Mac"
    : /CrOS/.test(s) ? "ChromeOS"
    : /Linux/.test(s) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}
