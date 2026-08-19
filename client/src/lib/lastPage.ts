/**
 * The page the user was on before opening the AI Assistant.
 *
 * The assistant is a full page, so "the current page" from inside it is
 * always the assistant itself. What the model actually needs — to read
 * "this page" / "here", and to pick navigate targets — is where the user
 * came from. Shell records every non-assistant route here as the user moves;
 * the assistant page reads it and sends the matching pageKey with each turn.
 * sessionStorage: per tab, survives a reload, gone when the tab closes.
 */
const KEY = "velocity.lastPageBeforeAssistant";
const ASSISTANT_PREFIX = "/v2/ai-assistant";

export function rememberPage(path: string): void {
  if (!path || path.startsWith(ASSISTANT_PREFIX)) return;
  try { sessionStorage.setItem(KEY, path); } catch { /* private mode etc. */ }
}

export function lastPageBeforeAssistant(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
