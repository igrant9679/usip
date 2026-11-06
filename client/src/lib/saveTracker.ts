/**
 * Which edits a save covered (audit 2026-10-20, G60).
 *
 * The mind map and the landing page editor kept one boolean: set on every edit,
 * cleared when a save returned. An edit made while that save was in flight was
 * cleared with it, shown as saved, and never sent. Counting edits instead, a
 * save clears only the edits that existed when it began.
 *
 *   const upTo = tracker.begin();   // when the save starts
 *   await save(...);
 *   tracker.saved(upTo);            // edits after begin() stay unsaved
 */
export class SaveTracker {
  private edits = 0;
  private savedUpTo = 0;

  /** Record one edit. */
  edit(): void {
    this.edits++;
  }

  /** A save is starting; pass the result to saved() when it succeeds. */
  begin(): number {
    return this.edits;
  }

  /** The save that began at `upTo` landed. */
  saved(upTo: number): void {
    if (upTo > this.savedUpTo) this.savedUpTo = upTo;
  }

  /** Fresh content was loaded, or local edits were discarded: nothing is unsaved. */
  reset(): void {
    this.savedUpTo = this.edits;
  }

  get dirty(): boolean {
    return this.edits > this.savedUpTo;
  }
}

/**
 * Ask before the tab closes or reloads while `dirty`. Returns the listener so a
 * caller can remove it; the browser shows its own wording.
 */
export function confirmLeaveWhile(dirty: () => boolean): (e: BeforeUnloadEvent) => void {
  return (e: BeforeUnloadEvent) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = "";
  };
}
