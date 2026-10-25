/**
 * Session helper. Verifies the JWT cookie, looks up the user row by openId.
 *
 * Replaces the prior Manus OAuth integration. Authentication is now native
 * email + password (see passwordAuth.ts for login + register routes); this
 * module only handles session validation on every authed request.
 */
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { nanoid } from "nanoid";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import { isSessionRevoked } from "./sessionRevocation";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

/**
 * What a verified token says. `jti` and `sessionVersion` are absent on tokens
 * minted before session revocation shipped (2026-10-24); those count as
 * version 0 and cannot be revoked one at a time (sessionRevocation.ts).
 */
export type VerifiedSession = SessionPayload & { jti?: string; sessionVersion: number; expiresAt?: Date };

class SDKServer {
  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }
    return new Map(Object.entries(parseCookieHeader(cookieHeader)));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    if (!secret) {
      throw new Error(
        "JWT_SECRET is not configured — set it before issuing or verifying sessions"
      );
    }
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a given user openId. The openId is the stable
   * identifier — for native registrations we generate one at signup time.
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string; sessionVersion?: number } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number; sessionVersion?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    // `sv` is the account's session_version when minted; `jti` names this one
    // token so logout can end it alone (sessionRevocation.ts).
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
      sv: options.sessionVersion ?? 0,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setJti(nanoid(21))
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<VerifiedSession | null> {
    if (!cookieValue) {
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name, sv, jti, exp } = payload as Record<string, unknown>;
      // `name` may be empty: it is a display hint minted from users.name, and
      // requiring it made every account with no name unable to hold a session
      // at all (found 2026-10-24 while adding revocation).
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || typeof name !== "string") {
        return null;
      }
      return {
        openId,
        appId,
        name,
        sessionVersion: typeof sv === "number" && Number.isFinite(sv) ? sv : 0,
        jti: isNonEmptyString(jti) ? jti : undefined,
        expiresAt: typeof exp === "number" ? new Date(exp * 1000) : undefined,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<User> {
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    const user = await db.getUserByOpenId(session.openId);
    if (!user) {
      // No external auto-sync — sessions can only refer to users that exist.
      throw ForbiddenError("User not found");
    }

    // Ended since it was minted: every session of the account (a password or
    // 2FA change bumped session_version) or this one alone (logout).
    if (session.sessionVersion !== (user.sessionVersion ?? 0)) {
      throw ForbiddenError("Session has been signed out");
    }
    if (session.jti) {
      const conn = await db.getDb();
      if (conn && (await isSessionRevoked(conn, session.jti))) {
        throw ForbiddenError("Session has been signed out");
      }
    }

    return user;
  }
}

export const sdk = new SDKServer();
