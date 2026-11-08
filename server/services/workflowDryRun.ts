/**
 * What a workflow rule WOULD do, without doing it (audit 2026-10-20, G19).
 *
 * The rule editor's Test button said "1 simulated run" and ran every real
 * action: it POSTed to the rule's webhook with whatever headers the rule held,
 * posted to Slack and Teams, created tasks, enrolled people, wrote fields and
 * drafted email. A test that sends is not a test. This reads the same action
 * list the engine runs (services/workflowEngine.ts runAction) and says, per
 * action, what it would do or why it couldn't, and touches nothing.
 */

type Action = { type?: string; params?: Record<string, any> };

export type DryRunResult = { plan: string[]; problems: string[] };

export function hostOf(url: unknown): string | null {
  try {
    const u = new URL(String(url ?? ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

export function describeRuleActions(
  actions: unknown,
  ws: { slackWebhookUrl?: string | null; teamsWebhookUrl?: string | null } | undefined,
): DryRunResult {
  const plan: string[] = [];
  const problems: string[] = [];
  const list = Array.isArray(actions) ? (actions as Action[]) : [];
  if (list.length === 0) problems.push("This rule has no actions.");
  for (const a of list) {
    const p = a?.params ?? {};
    switch (a?.type) {
      case "webhook": {
        const host = hostOf(p.url);
        if (!p.url) problems.push("webhook: no URL set");
        else if (!host) problems.push(`webhook: "${String(p.url).slice(0, 120)}" is not an http(s) URL`);
        else plan.push(`Would POST the event to ${host}`);
        break;
      }
      case "post_slack":
        if (!ws?.slackWebhookUrl) problems.push("post_slack: no Slack webhook configured");
        else plan.push("Would post a message to Slack");
        break;
      case "notify_teams":
        if (!ws?.teamsWebhookUrl) problems.push("notify_teams: no Teams webhook configured");
        else plan.push("Would post a message to Teams");
        break;
      case "create_task":
        plan.push(`Would create a task "${String(p.title ?? "Workflow task").slice(0, 120)}"`);
        break;
      case "notify":
      case "notify_user":
        plan.push(p.userId ? `Would notify user ${Number(p.userId)}` : "Would notify the record's owner");
        break;
      case "enroll_sequence":
        if (!(Number(p.sequenceId) > 0)) problems.push("enroll_sequence: no sequence set");
        else plan.push(`Would enrol the record in sequence ${Number(p.sequenceId)}`);
        break;
      case "update_field":
        if (!String(p.field ?? "").trim()) problems.push("update_field: no field set");
        else plan.push(`Would set ${String(p.field).slice(0, 60)} to "${String(p.value ?? "").slice(0, 120)}"`);
        break;
      case "send_email_draft":
        plan.push("Would write an email draft for review (nothing is sent without approval)");
        break;
      default:
        problems.push(`unsupported action type "${String(a?.type ?? "")}"`);
    }
  }
  return { plan, problems };
}
