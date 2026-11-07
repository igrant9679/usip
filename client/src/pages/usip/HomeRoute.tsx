/**
 * "/" — the home picked with "Set as home" (audit 2026-10-20, G56; the rule
 * is in `@/lib/homeChoice`). The Dashboard renders here as before; Home is a
 * hop with `replace: true`, so Back doesn't bounce through "/" again.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { HOME_DASHBOARD_KEY } from "@/components/usip/Shell";
import { DEFAULT_HOME, homeHref } from "@/lib/homeChoice";
import Dashboard from "./Dashboard";

function savedHome(): string | null {
  try {
    return localStorage.getItem(HOME_DASHBOARD_KEY);
  } catch {
    return null;
  }
}

export default function HomeRoute() {
  const [, setLocation] = useLocation();
  const href = homeHref(savedHome());
  useEffect(() => {
    if (href !== DEFAULT_HOME) setLocation(href, { replace: true });
  }, [href, setLocation]);
  return href === DEFAULT_HOME ? <Dashboard /> : null;
}
