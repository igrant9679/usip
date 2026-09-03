/**
 * /accounts and /accounts/:id → Companies (phase 5, 2026-09-02).
 *
 * AccountDetail was a second, legacy-shell company page over the same
 * `accounts` row CompanyProfile renders (same id). Its unique panels —
 * opportunities, custom fields, tasks, notes and files — moved into
 * CompanyProfile, so the page is retired and every old link lands on the
 * v2 profile with the id preserved.
 */
import { useEffect } from "react";
import { useParams, useLocation } from "wouter";

export function accountRedirectUrl(id?: string | null): string {
  return id && Number.isFinite(Number(id)) ? `/v2/companies/${Number(id)}` : "/v2/companies";
}

export default function AccountRedirect() {
  const { id } = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(accountRedirectUrl(id), { replace: true }); }, [id, setLocation]);
  return null;
}
