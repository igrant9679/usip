import { useWorkspace } from "@/contexts/WorkspaceContext";
import { isAdminRole, rankOf, ROLE_RANK } from "@shared/roleRank";

/**
 * The caller's role in the CURRENT workspace — the one every workspace
 * procedure checks (ctx.member.role).
 *
 * Not useAuth().user.role: that is the platform role, "user" or "admin", which
 * ranks 0 or 3 here. Reading it hid Enrich, Archive and Recalculate from every
 * workspace manager and admin whose platform role is "user", and showed them to
 * a platform admin the server would refuse (audit 2026-10-20, R10 / X1.3).
 */
export function useWorkspaceRole() {
  const { current } = useWorkspace();
  const role = current?.role ?? null;
  return {
    role,
    isManager: rankOf(role) >= ROLE_RANK.manager,
    isAdmin: isAdminRole(role),
  };
}
