/**
 * The six per-member permission toggles — one list, shared by both sides.
 *
 * THE DRIFT THIS PREVENTS. The key list existed twice: once in
 * `client/src/pages/usip/Team.tsx` (the switches an admin flips) and once
 * inline in `server/db.ts` (the `restrictedByDefault` array checkPermission
 * falls back to). Nothing tied them together, and they had already diverged in
 * the way that matters: the page's "Rep" template button wrote
 * `manage_sequences:false`, `view_all_leads:false` and
 * `manage_integrations:false` while the server GRANTED all three by default, so
 * an admin applying the preset silently took away power the UI never showed
 * them taking. Two of the six keys were, on top of that, read by nothing at all.
 *
 * ⚠️ A KEY ADDED HERE MUST BE ENFORCED SOMEWHERE. `server/permissionEnforcement.test.ts`
 * scans the server for a `checkPermission(ctx, "<key>")` / `hasPermission(ctx, "<key>")`
 * call per key and fails the suite when one has none, so a seventh toggle
 * cannot ship dead the way `view_all_leads` and `access_billing` did.
 *
 * No imports, deliberately: this file is reached from the client, from
 * `server/db.ts` (which nothing may import back) and from tests.
 */
export const PERMISSION_KEYS = [
  "export_data",
  "manage_sequences",
  "view_all_leads",
  "manage_integrations",
  "access_billing",
  "manage_api_keys",
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];

/**
 * Denied for manager/rep unless an explicit `member_permissions` row grants it.
 *
 * 2026-09-20: `access_billing` was REMOVED from this list. It had never been
 * enforced anywhere, and Settings → "Billing and credits" renders for every
 * role today (only the Save button is admin-only). Enforcing the key while it
 * still defaulted to denied would have taken that page away from every manager
 * and rep in every workspace on deploy, including the ones that never opened
 * the Permissions tab.
 *
 * ⚠️ IT IS NOT "TAKES NOTHING AWAY", and the first draft of this comment said
 * so. A member with an explicit deny ROW is refused, and the OLD Team.tsx
 * preset buttons wrote one: their hand-written manager/rep templates set
 * `access_billing: false` (and `manage_sequences: false`) across all six keys,
 * and nothing has ever deleted those rows. Anyone the "Mgr"/"Rep" preset was
 * applied to therefore loses the Billing panel — and sequence authoring — the
 * day these keys are first enforced. Production was checked before deploy:
 * zero `member_permissions` rows exist in any live workspace, so no backfill
 * migration was written for rows that do not exist. If that ever stops being
 * true, the honest cleanup is `DELETE FROM member_permissions WHERE granted = 0`
 * for the preset-written keys, because those denies are a side effect of a
 * button that described itself as "the role defaults".
 */
export const RESTRICTED_BY_DEFAULT: string[] = ["export_data", "manage_api_keys"];

export function isPermissionKey(k: string): boolean {
  return PERMISSION_KEYS.indexOf(k as PermissionKey) !== -1;
}

/**
 * The role fallback, taken when no override row exists.
 *
 * Takes a BOOLEAN, never a role string: every rank decision stays inside
 * `server/_core/workspace.ts` (roleRank.test.ts enforces the single rank map),
 * and this file stays importable from the client, which has no roles module.
 */
export function defaultGranted(feature: string, isElevated: boolean): boolean {
  return isElevated || RESTRICTED_BY_DEFAULT.indexOf(feature) === -1;
}

/**
 * The full six-key map a role resolves to with no override rows — what the
 * Team page's "apply template" buttons write.
 *
 * DERIVED, not hand-written. The presets used to be a literal table in
 * Team.tsx, and it disagreed with the server in both directions: the manager
 * preset granted export_data (the server denies it) and the rep preset denied
 * manage_sequences, view_all_leads and manage_integrations (the server grants
 * all three). Clicking "Rep" therefore TOOK AWAY three powers while presenting
 * itself as "set this member to the rep defaults".
 */
export function roleTemplate(isElevated: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < PERMISSION_KEYS.length; i++) {
    out[PERMISSION_KEYS[i]] = defaultGranted(PERMISSION_KEYS[i], isElevated);
  }
  return out;
}
