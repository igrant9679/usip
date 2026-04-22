import type { Express, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { scimEvents, scimProviders, users, workspaceMembers } from "../drizzle/schema";
import { getDb } from "./db";

/** Pure helper exported for tests. Validates an Authorization header value and resolves to a provider row when token matches. */
export async function verifyScimBearer(authHeader: string | undefined): Promise<{ ok: false; status: number } | { ok: true; provider: any }> {
  if (!authHeader) return { ok: false, status: 401 };
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return { ok: false, status: 401 };
  const token = m[1]!.trim();
  const db = await getDb();
  if (!db) return { ok: false, status: 503 };
  const rows = await db.select().from(scimProviders).where(eq(scimProviders.bearerToken, token)).limit(1);
  const provider = rows[0];
  if (!provider || !provider.enabled) return { ok: false, status: 401 };
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
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m) return res.status(401).json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Missing Bearer token", status: "401" });
      const token = m[1]!.trim();
      const db = await getDb();
      if (!db) return res.status(503).json({ detail: "DB unavailable", status: "503" });
      const provs = await db.select().from(scimProviders).where(eq(scimProviders.bearerToken, token)).limit(1);
      const provider = provs[0];
      if (!provider || !provider.enabled) return res.status(401).json({ detail: "Invalid or disabled provider", status: "401" });
      (req as any).scimProvider = provider;
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
    const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, provider.workspaceId));
    const userIds = members.map((m) => m.userId);
    if (userIds.length === 0) return res.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 0, Resources: [] });
    const allUsers = await db.select().from(users);
    const byId = new Map(allUsers.map((u) => [u.id, u]));
    const Resources = members
      .map((m) => byId.get(m.userId))
      .filter(Boolean)
      .map((u) => toScimUser(u as any));
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "GET", payload: { count: Resources.length } as any, responseStatus: 200 });
    res.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: Resources.length, Resources });
  });

  // Users — get one
  app.get("/api/scim/v2/Users/:id", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const u = rows[0];
    if (!u) return res.status(404).json({ status: "404", detail: "Not found" });
    res.json(toScimUser(u));
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
    // Ensure workspace membership (rep)
    const existingMem = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    if (!existingMem.find((m) => m.workspaceId === provider.workspaceId)) {
      await db.insert(workspaceMembers).values({ workspaceId: provider.workspaceId, userId, role: "rep" });
    }
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "POST", payload: body, responseStatus: 201 });
    const created = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]!;
    res.status(201).json(toScimUser(created));
  });

  // Users — replace/PATCH/delete (deprovision via membership removal)
  const handleReplace = async (req: Request, res: Response) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    const body = req.body ?? {};
    if (typeof body.active === "boolean" && body.active === false) {
      // Soft-deprovision: remove from this workspace
      await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, id));
      await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "PATCH", payload: body, responseStatus: 200 });
    }
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!rows[0]) return res.status(404).json({ status: "404" });
    res.json(toScimUser(rows[0]));
  };
  app.put("/api/scim/v2/Users/:id", handleReplace);
  app.patch("/api/scim/v2/Users/:id", handleReplace);

  app.delete("/api/scim/v2/Users/:id", async (req, res) => {
    const provider = (req as any).scimProvider as { id: number; workspaceId: number };
    const db = await getDb();
    if (!db) return res.status(503).end();
    const id = Number(req.params.id);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, id));
    await db.insert(scimEvents).values({ workspaceId: provider.workspaceId, providerId: provider.id, resource: "Users", method: "DELETE", payload: { id } as any, responseStatus: 204 });
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

function toScimUser(u: { id: number; openId: string; email: string | null; name: string | null }) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: String(u.id),
    externalId: u.openId,
    userName: u.email ?? u.openId,
    displayName: u.name ?? u.email ?? u.openId,
    emails: u.email ? [{ value: u.email, type: "work", primary: true }] : [],
    active: true,
  };
}
