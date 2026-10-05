/**
 * voiceToolTurns.ts — answering an xAI voice agent's function calls on a
 * socket Velocity holds (used by the xAI SIP bridge, 2026-10-05).
 *
 * xAI's rule: send every function_call_output of a response, then ONE
 * response.create so the agent carries on; and the function-call events
 * arrive alongside response.done, so the create waits for that too. Sending
 * it while a response is still open is refused.
 */
export class ToolTurns {
  private inflight = 0;
  private responseDone = false;
  private outputsSent = false;
  private stopped = false;

  constructor(private send: (event: Record<string, unknown>) => void) {}

  /** Feed every server event type through here. */
  onEvent(type: string): void {
    if (type === "response.created") this.responseDone = false;
    if (type === "response.done") {
      this.responseDone = true;
      this.maybeContinue();
    }
  }

  /** Run one function call and hand its output back. Never throws. */
  async run(callId: string, work: () => Promise<unknown>): Promise<void> {
    if (!callId || this.stopped) return;
    this.inflight++;
    let output: unknown;
    try {
      output = await work();
    } catch (e) {
      console.error("[VoiceToolTurns] tool failed:", e);
      output = { ok: false, error: "Something went wrong. Apologise and say the team will follow up." };
    }
    this.inflight--;
    if (this.stopped) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.outputsSent = true;
    this.maybeContinue();
  }

  /** The call is over: nothing more is sent. */
  stop(): void {
    this.stopped = true;
  }

  private maybeContinue(): void {
    if (this.stopped || this.inflight > 0 || !this.responseDone || !this.outputsSent) return;
    this.outputsSent = false;
    this.responseDone = false;
    this.send({ type: "response.create" });
  }
}
