/**
 * One run at a time: `run(start)` calls `start` unless the run it began last
 * hasn't called `done` yet, and says whether it started.
 *
 * A mutation's isPending reaches the screen a render after the call, so two
 * quick Enters both saw it false and made two lists (audit 2026-10-20, P135).
 */
export function createSingleFlight() {
  let busy = false;
  return (start: (done: () => void) => void): boolean => {
    if (busy) return false;
    busy = true;
    start(() => { busy = false; });
    return true;
  };
}
