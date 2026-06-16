# Velocity / usip — Session Handoff (Continue from here)

Refreshed at end of the "stability + invitations" session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`; deploys run ~5–12 min — verify live via API probes / DOM, not the first screenshot)
- **Tip of `main`:** `e056eda`. All work below is deployed; the invite flow + LLM/crash fixes were probed live in Personal Chrome.
- **Custom domain note:** the app moved from a `*.manus.space` domain to `getvelocityai.app` (Railway). This matters for anything domain-bound (see the OAuth removal below).

## This session's work (newest first)

### Invitations: overhauled end-to-end
The team-invite system was broken in several layered ways. All fixed + deployed; the full flow was verified live.

- **`e056eda` — Invite acceptance migrated OFF the removed Manus OAuth portal → native auth (THE big one).** `client/src/pages/InviteAccept.tsx` still redirected to the old Manus/Meta OAuth portal (`<portal>/app-auth` → `/api/oauth/callback`), which now **410s** and whose project rejected the `getvelocityai.app` redirect domain (the "redirect_uri domain not allowed" error the user hit). OAuth was replaced by native email+password (see Auth model below). Fix: a not-signed-in invitee now sets a password on the invite card, which POSTs to **`/api/auth/register`** — that endpoint **upgrades the invite placeholder in place** (sets passwordHash, `loginMethod="password"`, keeps the membership) and issues the session cookie. The page reloads with `?setup=done` so the now-authenticated page skips straight to `finaliseAcceptance` (clears the token). "Already have an account" → `/?returnPath=<invite>` (the native Landing auth form). Removed the dead OAuth redirect helper. **Verified live:** deployed bundle has zero `/app-auth` / `/api/oauth/callback` markers and contains `/api/auth/register` + the "Create account & join" CTA; the invite page renders the native password card, not the OAuth error.
- **`f2c6456` / `4252ec9` — resend / copy-link / re-invite now handle EXPIRED invites.** `resendInvitation` + `copyInviteLink` guarded on `loginMethod === "invite"`, but the nightly job flips unaccepted invites to `"expired_invite"` — so resending an expired invite (the whole point) failed with the misleading "Member has already accepted their invitation and signed in." Both now treat `invite` + `expired_invite` as pending and revive the user's `loginMethod` back to `"invite"` when re-issuing a token. The Invite-dialog re-issue path does the same.
- **`63d49bd` — invite mutation re-issues pending invites instead of CONFLICT.** It threw "already a member" on ANY membership row, so anyone who let a first invite lapse was permanently locked out. Now: pending invite (non-null `inviteToken`) → re-issue (fresh token/expiry, apply new role/title/quota, resend email, returns `reInvited:true`); genuinely active → CONFLICT; deactivated → "reactivate instead."
- **`e8384bd` — Team page shows invitation status.** `team.list` now returns `invitedAt`, `inviteExpiresAt`, and `invitePending` (token-presence boolean; raw token never leaves the server). The Status column shows **active / invited (with sent + expiry dates) / invite expired / deactivated**; a pending invite past its expiry renders as expired immediately (doesn't wait for the nightly job). 7-day expiry already existed (invite mutation default + `expireInvitations` nightly + 48h warning emails in `inviteExpiry.ts`); this makes it visible.

### Stability fixes
- **`8fdb816` — process-level crash guard.** Node 20 terminates on an unhandled promise rejection / uncaught exception by default, and the server had **zero** process handlers — one stray promise anywhere crashed the whole instance (the hard crash that needed a manual restart). Added `process.on("unhandledRejection")` + `("uncaughtException")` in `server/_core/index.ts` that log `[FATAL-GUARD] …` with full stack and keep the server alive. **If it crashes again, grep Railway logs for `[FATAL-GUARD]` — that's the root-cause pointer (a missing `.catch()`).**
- **`ca197b7` — LLM 429 "concurrent connections" fix.** ARE engine ticks fan out ~8 simultaneous Anthropic calls (`Promise.allSettled` over enrich+sequence agents), tripping the concurrent-connection rate limit. `invokeLLM` now serializes through a **process-wide semaphore** (default 2, override `LLM_MAX_CONCURRENCY`); the Anthropic client uses `maxRetries: 4` (honors `retry-after`). `runEnrichAgent` now treats 429/5xx/overload as **transient** (new export `isRetryableLLMError` in `server/_core/llm.ts`) → resets the prospect to `pending` for the next tick instead of stamping a hard `failed` with raw 429 JSON.

### Features earlier in the session
- **`64bbaa7` — Personas categories.** New `persona_categories` table (**migration 0089**) + `personas.categoryId`. Page renders one collapsible section per category with create / rename / delete (personas fall back to Uncategorized) / reorder (server `sortOrder`) / per-section collapse (localStorage). Persona editor + each section header gained a category picker / quick-add. Router: workspace-scoped `listCategories`/`createCategory`/`updateCategory`/`deleteCategory`/`reorderCategories`; caller-supplied `categoryId` is ownership-validated.
- **`9c5d8f0` — Sequence step editor minimize.** `StepEditor` (in `Sequences.tsx`) — each step header is a click-to-collapse toggle; email steps with content start minimized as a subject-line outline. Collapse state remaps correctly on move/remove.

## 🔑 Auth model (learned this session — durable, read before touching auth/invites)
- **Auth is native email + password (`server/passwordAuth.ts`). The Manus/Meta OAuth flow was REMOVED.** `/api/oauth/callback` returns **410 Gone**. Do not reintroduce OAuth-portal redirects.
- **There is NO `/login` route.** The login/signup UI is the `Landing` component **inside `client/src/App.tsx`** (rendered by `AuthGate` when unauthenticated). It posts to `/api/auth/password-login` (signin) or `/api/auth/register` (signup), reads `?returnPath=` from the URL, and has both modes. `client/src/pages/PasswordLogin.tsx` exists but is **not routed** — ignore it.
- **`/api/auth/register` upgrades an invite placeholder in place** (sets password, `loginMethod="password"`, preserves `workspaceMembers`); 409 only if the email already has a real password.
- **Invite lifecycle:** placeholder user has `openId = "invite:<email>"`, `loginMethod="invite"` (pending) → nightly `expireInvitations` flips to `"expired_invite"` → acceptance sets a real `loginMethod` and clears `inviteToken`. **`inviteToken` non-null ⇔ outstanding/unaccepted.** `hasPassword` + `loginMethod` distinguish accepted from pending. Invite expiry default **7 days** (per-workspace `workspaceSettings.inviteExpiryDays`, `0` = never; editable in Team → Settings).
- `finaliseAcceptance` (in `routers/admin.ts`) clears the token and accepts both `invite`/`expired_invite` as pending; a real `loginMethod` takes the "already accepted" branch.

## 🪤 Bug classes (do not reintroduce)
- **DialogContent `sm:max-w-lg`:** `ui/dialog.tsx` default className ends with `sm:max-w-lg`; a bare `max-w-2xl` LOSES at ≥640px (tailwind-merge keeps both). Always override with the same prefix: `sm:max-w-2xl` (+ optional `max-w-[calc(100%-2rem)]`). Repo had a full sweep to zero bare instances — keep it that way.
- **Flex-collapse:** bare top-level flex rows under the shell need `shrink-0` or they collapse / steal clicks. SubNav/PageHeader are `shrink-0`. `min-h-0` trap on flex children that scroll.
- **Migration drift:** schema = drizzle journal ∪ `server/_core/rawMigrations.ts`. Schema changes go in BOTH `drizzle/schema.ts` AND rawMigrations. Latest applied: **0089** (persona_categories). **Next is 0090.** rawMigrations are idempotent (tolerated errnos 1050/1060/1061/1091/1146/1826), run 5s post-boot, never block startup.

## How this codebase works (essentials)
- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle ORM (mysql2) + Express. **Node 20** in prod (`.node-version` = 20). esbuild does NOT typecheck but FAILS on missing exports/unresolved imports — grep repo-wide before deleting an export. TS type errors only surface at runtime.
- **Build:** Railway runs `vite build && esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm`. pnpm frozen lockfile — don't add deps without updating `pnpm-lock.yaml`. Verify locally with `npx esbuild <file> --loader:.tsx=tsx --jsx=automatic --outfile=NUL` (parse check) or the full bundle command to a temp dir.
- **No local toolchain for running** — verify via static review → commit → push → watch Railway → check live in Chrome.
- tRPC: `workspaceProcedure` etc.; **every DB query must filter by `ctx.workspace.id`**; treat any caller-controlled id as hostile (validate ownership → 404).
- Engine crons (`server/_core/index.ts`, all `.catch()`-guarded): `runAreEngine()` ~3min, `processEnrollments()` ~5min (enforces send window/timezone), `runPipelineAlertsCron()` ~15min, nightly batch (incl. `expireInvitations` + invite warning emails). `invokeLLM` (server/_core/llm.ts) default model `claude-haiku-4-5`, global concurrency semaphore, `isRetryableLLMError` export. Email send via `sendWorkspaceEmail` (workspace SMTP / Email Delivery settings; failures non-fatal).
- **Reuse:** ConfirmButton / TableSkeleton / QueryError / SubNav / EmailClientPreview. Dark mode via theme tokens. New dialogs: `sm:max-w-*` overrides only.

## Live data state of LSI Media (workspace id 2)
- **Team (4 members):** `idris.grant@lsi-media.com` (you, admin), `sabine.grant`, `lucas.grant`, **`bianca.espeso@lsi-media.com`** — pending **admin** invite, fresh link **expires 2026-06-23**, no password yet. Her acceptance flow was verified working live this session.
- **Pipeline / Customers / Accounts / Contacts / Leads / Prospects:** empty (cleared in an earlier session).
- **Sequences:** 1 — "AI CONSULT - INITIAL OUTREACH" (id 10, paused), 1 email step linked to template 6.
- **Email templates:** 7 (ids 2–8), all with clean `{{tags}}` htmlOutput.
- **ARE:** campaign 7 has 11 rejected prospects (Rejections tab only).
- **Personas:** no user categories created yet (feature shipped; all personas currently Uncategorized).

## OPEN USER ACTIONS
- **bianca:** nothing required from the dev side — she can accept via her invite link (set a password on the card) or sign up at `getvelocityai.app` with her email. Optionally confirm she reaches the dashboard.
- **Unipile webhook auth (from a prior session, still open):** set `UNIPILE_WEBHOOK_SECRET` on Railway, then re-run the three register-webhook admin actions to activate verification.
- **If the instance crashes again:** grep Railway logs for `[FATAL-GUARD]` to find the offending stray promise (the guard keeps it alive + logs the stack).

## Git identity (every commit)
```bash
git -c user.name='igrant9679' -c user.email='206445972+igrant9679@users.noreply.github.com' \
  commit -m "$(cat <<'EOF'
<message>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Commit + push per change. Stage specific files (parallel sessions leave untracked files at root — `HANDOFF.md` / `UX_AUDIT.md` belong to another session; leave them).

## Verification: Personal Chrome via Claude-in-Chrome MCP
- `list_connected_browsers` → `select_browser` (deviceId for **"Personal Chrome"**, isLocal). Always confirm which browser.
- `tabs_context_mcp({createIfEmpty:true})` for a tab. Driving tRPC via `javascript_tool` fetch is the fastest server probe: queries `GET /api/trpc/<proc>?batch=1&input=...` (results under `[0].result.data.json`); mutations `POST /api/trpc/<proc>?batch=1` body `{"0":{json:{...}}}`. The session runs as **idris** (admin) — `team.list`, `team.copyInviteLink`, `team.resendInvitation`, `team.getLoginHistory`, `auth.me` all work.
- Caveat: loading `/invite/accept` in this browser shows the **signed-in** card (idris's cookie), not the logged-out invitee card — don't submit it (would set the invitee's password). The session cookie is HttpOnly; you can't clear it from JS, and you can't sign idris back in. Verify logged-out paths by scanning the deployed JS bundle instead.

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: e056eda.

Read SESSION_HANDOFF.md at the repo root first — especially the "Auth model" and
"Bug classes" sections.

State (all shipped + deployed this session):
- Invitations overhauled: acceptance migrated OFF the removed Manus OAuth portal to
  native email+password (InviteAccept.tsx → /api/auth/register, which upgrades the
  invite placeholder in place); resend/copy-link/re-invite now handle expired invites
  instead of "already a member"; Team page shows invitation status (active / invited /
  expired) with sent+expiry dates. 7-day invite expiry is the default.
- Stability: process-level crash guard ([FATAL-GUARD] logs, keeps Node alive — Node 20
  was crashing on unhandled rejections); LLM global concurrency semaphore + maxRetries 4
  + transient-429 handling fixed the ARE "concurrent connections rate limit" enrichment
  failures (isRetryableLLMError in server/_core/llm.ts, LLM_MAX_CONCURRENCY override).
- Features: Personas categories (migration 0089, create/rename/delete/reorder/collapse);
  sequence step-editor per-step minimize.

KEY ARCHITECTURE (learned this session):
- Auth is native email+password (passwordAuth.ts). OAuth was REMOVED; /api/oauth/callback
  is 410. There is NO /login route — the login/signup UI is the Landing component inside
  App.tsx (AuthGate renders it when unauthenticated; reads ?returnPath=). PasswordLogin.tsx
  is unrouted, ignore it. /api/auth/register upgrades an invite placeholder in place.
- Invite lifecycle: openId "invite:<email>", loginMethod "invite"→"expired_invite"
  (nightly expireInvitations)→real method on acceptance; inviteToken non-null = unaccepted.

Hard constraints (still apply):
- Build runs on Railway (Node 20); pnpm frozen lockfile. Verify via static review →
  commit → push → watch Railway → check live in Chrome. Don't add deps without lockfile.
- esbuild fails on missing exports; grep repo-wide before deleting an export.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (next: 0090).
- Commit + push per change, igrant9679 identity + Opus 4.8 co-author trailer; stage
  specific files (HANDOFF.md / UX_AUDIT.md at root belong to another session — leave them).
- Every DB query filters by ctx.workspace.id; treat caller-controlled ids as hostile.
- Plan first when non-trivial; user approves before large code lands.
- Reuse ConfirmButton / TableSkeleton / QueryError / SubNav / EmailClientPreview; theme
  tokens for dark mode; dialogs need sm:max-w-* overrides (never bare max-w-*).
- Always ask which Chrome browser before driving it (Personal Chrome, isLocal). The MCP
  session runs as idris (admin); drive tRPC via javascript_tool fetch.
- ui-ux-pro-max skill for UI/UX design work.

Live data: LSI Media (ws id 2), 4 members incl. bianca.espeso (pending admin invite,
link expires 2026-06-23, no password yet — acceptance flow verified live). Pipeline/CRM
empty. 1 paused sequence (id 10). 7 clean templates. Campaign 7 has 11 rejected prospects.

OPEN: (1) bianca can self-accept, optionally confirm she reaches dashboard; (2) set
UNIPILE_WEBHOOK_SECRET on Railway + re-run 3 register-webhook actions (prior session);
(3) if it crashes, grep Railway logs for [FATAL-GUARD].

After reading, briefly confirm current state, then wait for direction.
```
