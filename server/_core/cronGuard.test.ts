import { describe, it, expect, vi } from "vitest";
import { guardOverlap } from "./cronGuard";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("guardOverlap", () => {
  it("runs the task when nothing is in flight", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const run = guardOverlap("t", task);
    run();
    await tick();
    expect(task).toHaveBeenCalledTimes(1);
  });

  /** The whole point: a second tick during a slow run must not start. */
  it("skips a tick while the previous run is still going", async () => {
    let release: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const run = guardOverlap("t", task);
    run();
    await tick();
    run();
    run();
    await tick();
    expect(task).toHaveBeenCalledTimes(1);
    expect(run.skipped()).toBe(2);
    release();
    await tick();
    expect(run.isRunning()).toBe(false);
  });

  it("runs again once the previous run finishes", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const run = guardOverlap("t", task);
    run();
    await tick();
    run();
    await tick();
    expect(task).toHaveBeenCalledTimes(2);
    expect(run.skipped()).toBe(0);
  });

  /**
   * A rejected task MUST clear the flag. Otherwise one failure wedges the
   * engine off until the next deploy — worse than the overlap being prevented.
   */
  it("clears the in-flight flag when the task rejects", async () => {
    const task = vi.fn().mockRejectedValue(new Error("boom"));
    const run = guardOverlap("t", task);
    run();
    await tick();
    await tick();
    expect(run.isRunning()).toBe(false);
    run();
    await tick();
    expect(task).toHaveBeenCalledTimes(2);
  });

  /** Same for a task that throws synchronously before returning a promise. */
  it("clears the flag when the task throws synchronously", async () => {
    const task = vi.fn(() => { throw new Error("sync boom"); });
    const run = guardOverlap("t", task as never);
    run();
    await tick();
    await tick();
    expect(run.isRunning()).toBe(false);
  });

  it("never lets an error escape to the scheduler", () => {
    const run = guardOverlap("t", () => Promise.reject(new Error("x")));
    expect(() => run()).not.toThrow();
  });
});
