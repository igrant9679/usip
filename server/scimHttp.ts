import type { Express, Request, Response, NextFunction } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { scimEvents, scimProviders, users, workspaceMembers, workspaces } from "../drizzle/schema";
import { getDb } from "./db";
import { leavesNoActiveSuperAdmin } from "./_core/workspace";

/**
 * What `scim_providers.bearerToken` holds: a SHA-256 of the token, never the
 * token (audit 2026-10-20, G49). It was stored as issued, matched by equality
 * and sent back to the admin's browser by listProviders, so anyone who could
 * read the table or the page held a credential that provisions users.
 */
export function hashScimToken(token: string): string {
  return "sha256:" + crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Pure helper exported for tests. Validates an Authorization header value and resolves to a provider row when token matches. */
export async function verifyScimBearer(authHeader: string | undefined): Promise<{ ok: false; status: number } | { ok: true; provider: any }> {
  if (!authHeader) return { ok: false, status: 401 };
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return { ok: false, status: 401 };
  const token = m[1]!.trim();
  const db = await getDb();
  if (!db) return { ok: false, status: 503 };
  const hashed = hashScimToken(token);
  // The raw token still matches a row issued before tokens were hashed; that
  // row is hashed on its first use, so the IdP's token keeps working and the
  // plaintext leaves the table.
  const rows = await db.select().from(scimProviders).where(inArray(scimProviders.bearerToken, [hashed, token])).limit(1);
  const provider = rows[0];
  if (!provider || !provider.enabled) return { ok: false, status: 401 };
  // A stored hash presented as the token is not the token: only a row that
  // still holds plaintext may match on the raw value.
  if (provider.bearerToken !== hashed && provider.bearerToken.startsWith("sha256:")) return { ok: false, status: 401 };
  if (provider.bearerToken === token) {
    await db.update(scimProviders).set({ bearerToken: hashed })
      .where(and(eq(scimProviders.id, provider.id), eq(scimProviders.bearerToken, token)));
  }
  return { ok: true, provider };
}

/**
 * SCIM 2.0 endpoints.
 * Mounted under /api/scim/v2 — public, bearer-token authenticated against `scim_providers.bearer_token`.
 * v1 scope: ServiceProviderConfig + Users (create/list/get/replace/patch/delete) + Groups (read-only).
 *
 * Each authenticated request looks up the workspace via the bearer token, scopes data accordingly,
 * and logs the event into `scim_events` for the audit trail UI.
 */
export function registerScimRoutes(app: Express) {
  app.use("/api/scim/v2", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.header("authorization") ?? "";
      if (!/^Bearer\s+(.+)$/i.test(auth)) return res.status(401).json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Missing Bearer token", status: "401" });
      // One check for the token, the same as verifyScimBearer's (hashed, G49).
      const verified = await verifyScimBearer(auth);
      if (!verified.ok) {
        if (verified.status === 503) return res.status(503).json({ detail: "DB unavailable", status: "503" });
        return res.status(401).json({ detail: "Invalid or disabled provider", status: "401" });
      }
      (req as any).scimProvider = verified.provider;
      next();
    } catch (e) {
      console.error("[scim] auth error", e);
      res.status(500).json({ detail: "Internal error", status: "500" });
    }
  });

  // ServiceProviderConfig
  app.get("/api/scim/v2/ServiceProviderConfig", (_req, res) => {
    res.json({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Provider bearer token", primary: true }],
    });
  });

  app.get("/api/scim/v2/Schemas", (_req, res) => {
    res.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 0, Resources: [] });
  });

  // Users — list
  app.get("/api/scim/v2/Users", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    /**
     * The filter is honoured (audit 2026-10-20, G7). It was ignored, so the
     * existence check every IdP makes before creating someone —
     * `filter=userName eq "x"` — came back with the whole workspace, and the
     * IdP took the first person listed to be the one it asked about.
     * Anything we can't read is refused, never answered with everyone.
     */
    const filter = parseScimFilter(typeof req.query?.filter === "string" ? req.query.filter : undefined);
    if (filter === "invalid") {
      return res.status(400).json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], scimType: "invalidFilter", detail: "Supported filters: userName, emails.value, externalId or id, with eq", status: "400" });
    }
    const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role, deactivatedAt: workspaceMembers.deactivatedAt }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, provider.workspaceId));
    const userIds = members.map((m) => m.userId);
    // This workspace's members only — it used to load every user of every
    // workspace to build the map (audit 2026-10-20).
    const memberUsers = userIds.length ? await db.select().from(users).where(inArray(users.id, userIds)) : [];
    const byId = new Map(memberUsers.map((u) => [u.id, u]));
    const all = members
      .map((m) => ({ u: byId.get(m.userId), m }))
      .filter((r): r is { u: NonNullable<typeof r.u>; m: typeof r.m } => !!r.u)
      .map((r) => toScimUser(r.u, r.m))
      .filter((r) => !filter || scimFilterMatches(filter, r));
    // 1-based, as SCIM pages are (RFC 7644 §3.4.2.4).
    const startIndex = Math.max(1, Number(req.query?.startIndex) || 1);
    const pageSize = Math.min(200, Math.max(0, Number.isFinite(Number(req.query?.count)) && req.query?.count !== undefined ? Number(req.query.count) : 200));
    const Resources = all.slice(startIndex - 1, startIndex - 1 + pageSize);
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "GET", payload: { count: Resources.length, filter: filter ? `${filter.attr} eq` : null } as any, responseStatus: 200 });
    res.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: all.length, startIndex, itemsPerPage: Resources.length, Resources });
  });

  // Users — get one
  app.get("/api/scim/v2/Users/:id", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    // A provider sees ITS workspace's members only (audit 2026-10-20: any
    // user of any workspace could be read by id).
    const found = await scimMember(db, provider.workspaceId, id);
    if (!found) return res.status(404).json({ status: "404", detail: "Not found" });
    res.json(toScimUser(found.u, found.m));
  });

  // Users — create (provision)
  app.post("/api/scim/v2/Users", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const body = req.body ?? {};
    const email = body.emails?.[0]?.value ?? body.userName;
    if (!email) return res.status(400).json({ status: "400", detail: "userName/email required" });
    // Idempotent: lookup or create user, then ensure membership
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let userId: number;
    if (existing[0]) {
      userId = existing[0].id;
    } else {
      const r = await db.insert(users).values({
        openId: `scim-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
        email,
        name: body.displayName ?? (`${body.name?.givenName ?? ""} ${body.name?.familyName ?? ""}`.trim() || email),
        loginMethod: "scim",
        role: "user",
      });
      userId = Number((r as any)[0]?.insertId ?? 0);
    }
    // Ensure workspace membership (rep). An account that already exists
    // elsewhere joins as a PENDING invitation (audit 2026-10-20, the C1 rule):
    // a provider's token must not make a stranger's account a member of its
    // workspace without them accepting. An account this call created is the
    // provider's own, and starts active.
    const existingMem = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    if (!existingMem.find((m) => m.workspaceId === provider.workspaceId)) {
      const pending = !!existing[0] && existingMem.length > 0;
      await db.insert(workspaceMembers).values({
        workspaceId: provider.workspaceId,
        userId,
        role: "rep",
        ...(pending ? { inviteToken: crypto.randomBytes(32).toString("hex") } : {}),
      });
    }
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "POST", payload: body, responseStatus: 201 });
    const created = await scimMember(db, provider.workspaceId, userId);
    res.status(201).json(toScimUser(created!.u, created!.m));
  });

  /**
   * Users — replace/PATCH/delete. Deprovisioning DEACTIVATES the membership
   * here, the way team.deactivate does (audit 2026-10-20, G7). It used to
   * delete the row, which lost the person's history in this workspace, made
   * `active` meaningless, and left them with no membership at all, so their
   * next request had ensureUserHasWorkspace make them super_admin of a fresh
   * seeded workspace. `active: true` brings a deactivated member back.
   */
  const handleReplace = async (req: Request, res: Response) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    const body = req.body ?? {};
    const found = await scimMember(db, provider.workspaceId, id);
    if (!found) return res.status(404).json({ status: "404" });
    const active = requestedActive(body);
    if (active !== undefined) {
      const method = req.method === "PUT" ? "PUT" : "PATCH";
      const refused = await setScimActive(db, provider, found, active);
      await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method, payload: body, responseStatus: refused ? 409 : 200 });
      if (refused) return res.status(409).json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: refused, status: "409" });
    }
    const after = await scimMember(db, provider.workspaceId, id);
    res.json(toScimUser(after!.u, after!.m));
  };
  app.put("/api/scim/v2/Users/:id", handleReplace);
  app.patch("/api/scim/v2/Users/:id", handleReplace);

  app.delete("/api/scim/v2/Users/:id", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    // Scoped to the provider's workspace, and a deactivation, not a delete (G7).
    const found = await scimMember(db, provider.workspaceId, id);
    if (!found) return res.status(404).json({ status: "404" });
    const refused = await setScimActive(db, provider, found, false);
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "DELETE", payload: { id } as any, responseStatus: refused ? 409 : 204 });
    if (refused) return res.status(409).json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: refused, status: "409" });
    res.status(204).end();
  });

  // Groups — minimal
  app.get("/api/scim/v2/Groups", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    res.json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 4,
      Resources: ["super_admin", "admin", "manager", "rep"].map((r, i) => ({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        id: `${provider.workspaceId}-${r}`,
        displayName: r,
        members: [],
      })),
    });
  });
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ScimMembership = { id: number; role: string; deactivatedAt: Date | null; inviteToken: string | null };

/** The user and their membership, if they are (or were) a member of this provider's workspace. */
async function scimMember(db: Db, workspaceId: number, userId: number) {
  if (!Number.isFinite(userId)) return null;
  const [row] = await db
    .select({ u: users, m: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row ? { u: row.u, m: row.m as ScimMembership } : null;
}

/**
 * Deactivate or reactivate a membership for an IdP. Returns why not, or null.
 * The rules team.deactivate keeps hold here too: never the last active super
 * admin, never the workspace's owner — an IdP is not a way round them.
 */
async function setScimActive(
  db: Db,
  provider: { workspaceId: number },
  found: { u: { id: number }; m: ScimMembership },
  active: boolean,
): Promise<string | null> {
  if (active) {
    if (found.m.deactivatedAt) {
      await db.update(workspaceMembers).set({ deactivatedAt: null })
        .where(and(eq(workspaceMembers.id, found.m.id), eq(workspaceMembers.workspaceId, provider.workspaceId)));
    }
    return null;
  }
  if (found.m.deactivatedAt) return null;
  if (await leavesNoActiveSuperAdmin(db, provider.workspaceId, [found.m])) {
    return "This person is the workspace's only active super admin. Make someone else a super admin in Velocity first.";
  }
  const [ws] = await db.select({ ownerUserId: workspaces.ownerUserId }).from(workspaces).where(eq(workspaces.id, provider.workspaceId)).limit(1);
  if (ws && ws.ownerUserId === found.u.id) {
    return "This person owns the workspace. Transfer ownership in Velocity before deprovisioning them.";
  }
  await db.update(workspaceMembers).set({ deactivatedAt: new Date() })
    .where(and(eq(workspaceMembers.id, found.m.id), eq(workspaceMembers.workspaceId, provider.workspaceId), isNull(workspaceMembers.deactivatedAt)));
  return null;
}

/**
 * The `active` a PUT or PATCH asks for, or undefined when it doesn't say.
 * PUT carries it at the top level; a PatchOp carries it as
 * `{ op: "replace", path: "active", value: false }` or
 * `{ op: "replace", value: { active: false } }`. Some IdPs send "Replace"
 * and the string "False".
 */
export function requestedActive(body: any): boolean | undefined {
  const asBool = (v: unknown): boolean | undefined =>
    typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v.trim()) ? v.trim().toLowerCase() === "true" : undefined;
  let out = asBool(body?.active);
  const ops = Array.isArray(body?.Operations) ? body.Operations : [];
  for (const op of ops) {
    const kind = String(op?.op ?? "").toLowerCase();
    if (kind !== "replace" && kind !== "add") continue;
    if (typeof op.path === "string" && op.path.trim().toLowerCase() === "active") out = asBool(op.value) ?? out;
    else if (!op.path && op.value && typeof op.value === "object") out = asBool(op.value.active) ?? out;
  }
  return out;
}

type ScimFilter = { attr: "userName" | "emails.value" | "externalId" | "id"; value: string };

/**
 * The filters IdPs send to look someone up: `<attr> eq "<value>"`. Returns
 * null for no filter, and "invalid" for anything else, which is refused.
 */
export function parseScimFilter(raw: string | undefined): ScimFilter | null | "invalid" {
  if (raw === undefined || raw.trim() === "") return null;
  const m = /^\s*(userName|emails\.value|emails|externalId|id)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  if (!m) return "invalid";
  const key = m[1]!.toLowerCase();
  const attr: ScimFilter["attr"] = key === "username" ? "userName" : key === "externalid" ? "externalId" : key === "id" ? "id" : "emails.value";
  return { attr, value: m[2]!.replace(/\\(.)/g, "$1") };
}

function scimFilterMatches(f: ScimFilter, u: ReturnType<typeof toScimUser>): boolean {
  // userName and emails are not case-exact in SCIM's core schema; ids are.
  const ci = (a: string) => a.toLowerCase() === f.value.toLowerCase();
  if (f.attr === "userName") return ci(u.userName);
  if (f.attr === "emails.value") return u.emails.some((e) => ci(e.value));
  if (f.attr === "externalId") return u.externalId === f.value;
  return u.id === f.value;
}

function toScimUser(
  u: { id: number; openId: string; email: string | null; name: string | null },
  m: { deactivatedAt: Date | null },
) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: String(u.id),
    externalId: u.openId,
    userName: u.email ?? u.openId,
    displayName: u.name ?? u.email ?? u.openId,
    emails: u.email ? [{ value: u.email, type: "work", primary: true }] : [],
    // This workspace's membership, not a constant (G7): every user read as
    // active, the deprovisioned included.
    active: !m.deactivatedAt,
  };
}
