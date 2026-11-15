/**
 * The page the user was on before opening Elsie's full page.
 *
 * The assistant is a full page, so "the current page" from inside it is
 * always the assistant itself. What the model actually needs — to read
 * "this page" / "here", and to pick navigate targets — is where the user
 * came from. Shell records every non-assistant route here as the user moves;
 * the assistant page reads it and sends the matching pageKey with each turn.
 * sessionStorage: per tab, survives a reload, gone when the tab closes.
 *
 * 2026-11-15: the whole address is kept (path and query), because the record
 * id and the tab are in it and the assistant is now told what is on screen
 * (shared/assistantScreen). `pathOf` gives the path alone for page keys.
 */
const KEY = "velocity.lastPageBeforeAssistant";
const ASSISTANT_PREFIX = "/v2/ai-assistant";

export function rememberPage(path: string, search = ""): void {
  if (!path || path.startsWith(ASSISTANT_PREFIX)) return;
  try { sessionStorage.setItem(KEY, addressOf(path, search)); } catch { /* private mode etc. */ }
}

/** "/prospects/12" + "tab=emails" → "/prospects/12?tab=emails", capped to what the server accepts. */
export function addressOf(path: string, search = ""): string {
  const q = search.replace(/^\?/, "");
  return (q ? `${path}?${q}` : path).slice(0, 300);
}

export function pathOf(address: string): string {
  const q = address.indexOf("?");
  return q === -1 ? address : address.slice(0, q);
}

export function lastPageBeforeAssistant(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
