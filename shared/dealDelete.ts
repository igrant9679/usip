/**
 * What deleting a deal removes with it, in the words both delete confirmations
 * use (audit 2026-10-20, R32). opportunities.delete removes exactly these, in
 * one transaction; proposals, tasks and activities that mention the deal stay.
 */
export const OPPORTUNITY_DELETE_SCOPE = "along with its line items, contact roles, quotes, stage history and alerts";
