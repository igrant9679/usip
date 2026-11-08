/**
 * sendingStatus — the one read behind the sending status bar (audit
 * 2026-10-20, U1): what is stopping sends in this workspace right now.
 * Display only; see services/sendingStatus.ts for the sources it reads.
 */
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { sendingStatus } from "../services/sendingStatus";

export const sendingStatusRouter = router({
  current: workspaceProcedure.query(({ ctx }) => sendingStatus(ctx.workspace.id)),
});
