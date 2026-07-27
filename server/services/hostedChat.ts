/**
 * Which chat agent — if any — rides along on Velocity's own public pages.
 *
 * The chat agent books meetings only where visitors actually are, so it has to
 * be installed somewhere. There are two installs: an external site pastes the
 * `/v/chat.js` launcher, and the pages Velocity hosts itself (/l/:slug landing
 * pages, /b/:slug booking pages) carry it in-app. This module is the second.
 *
 * `pickHostedAgent` enforces the SAME eligibility `chatAgents.getPublic`
 * enforces — published, and not `off`. If the two ever diverge, a hosted page
 * renders a launcher whose iframe then refuses to serve, which reads to a
 * visitor as a broken widget rather than as an absent one.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { chatAgents } from "../../drizzle/schema";

export interface HostedAgentRow {
  id: number;
  slug: string;
  status: string;
  mode: string;
  showOnHostedPages: boolean;
}

/**
 * The agent to show on hosted pages, or null. Pure — the eligibility rules are
 * the whole point of this file and they are tested directly.
 */
export function pickHostedAgent<T extends HostedAgentRow>(rows: T[]): T | null {
  const eligible = (rows ?? []).filter(
    (r) => r && r.showOnHostedPages && r.status === "published" && r.mode !== "off" && !!r.slug,
  );
  if (!eligible.length) return null;
  // A workspace can flag more than one; oldest wins so the choice is stable
  // rather than dependent on row order.
  return eligible.reduce((a, b) => (b.id < a.id ? b : a));
}

/**
 * Public slug of the workspace's hosted-page agent, or null.
 *
 * Never throws: the launcher is an addition to a landing/booking page, and a
 * lookup failure must cost the page nothing.
 */
export async function hostedPageChatSlug(workspaceId: number): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({
        id: chatAgents.id,
        slug: chatAgents.slug,
        status: chatAgents.status,
        mode: chatAgents.mode,
        showOnHostedPages: chatAgents.showOnHostedPages,
      })
      .from(chatAgents)
      .where(eq(chatAgents.workspaceId, workspaceId));
    return pickHostedAgent(rows)?.slug ?? null;
  } catch {
    return null;
  }
}
