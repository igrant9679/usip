import { trpc } from "@/lib/trpc";
import { safeTimezone } from "@shared/availability";

/**
 * The zone this workspace's days are counted in, read as the server reads it
 * (getWorkspaceTimezone): the saved zone, or UTC if it is not a real one.
 *
 * Until settings answer, the viewer's own zone stands in, which is right for
 * most people and only ever a label or a picker's limit. Anything that writes a
 * day back must wait for `isLoading` to clear, or it can save the wrong day.
 */
export function useWorkspaceTimezone(): { timezone: string; isLoading: boolean } {
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  return {
    timezone: settings.data ? safeTimezone(settings.data.timezone) : Intl.DateTimeFormat().resolvedOptions().timeZone,
    isLoading: settings.isLoading,
  };
}
