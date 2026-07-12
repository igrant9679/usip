/**
 * NotificationPrefs — legacy route stub.
 *
 * The Notifications settings UI now lives inside the Settings hub at
 * /v2/settings/notifications (see components/usip/settings/NotificationsSection).
 * This standalone route is kept alive for deep links and muscle memory; it just
 * redirects to the hub page so there is a single Notifications surface.
 */
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function NotificationPrefs() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/v2/settings/notifications", { replace: true });
  }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}
