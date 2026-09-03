/**
 * SavedRedirect — /v2/saved-people and /v2/saved-companies were the Lists
 * page filtered by type: same router (recordLists), same detail page, two
 * extra destinations. Folded into Lists (phase 4, 2026-09-02); the type
 * survives as ?type= so a bookmark lands on the right section.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";

export function savedRedirectUrl(entityType: "people" | "companies"): string {
  return `/v2/lists?type=${entityType}`;
}

export default function SavedRedirect({ entityType }: { entityType: "people" | "companies" }) {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(savedRedirectUrl(entityType), { replace: true }); }, [entityType, setLocation]);
  return null;
}
