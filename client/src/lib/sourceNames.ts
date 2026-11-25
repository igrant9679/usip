/**
 * useSourceNames — what this viewer calls each prospect source (owner
 * 2026-11-25): "Source N" and its description for every member, the
 * vendor's true name for the platform owner only. Every screen that names a
 * prospect source asks here (prospectSources.names), never a vendor label of
 * its own; the guard test server/sourceNamesGuard.test.ts holds that.
 *
 * Channels that are the member's own (LinkedIn, the internal CRM, news) and
 * Google Business keep their plain labels from @shared/areSources.
 */
import { trpc } from "@/lib/trpc";
import { ARE_SOURCES } from "@shared/areSources";
import { PROSPECT_DATABASE_SLUGS, isProspectDatabase } from "@shared/prospectSources";
import { anonymizeVendorText, type SourceName } from "@shared/sourceNames";

export type SourceNamer = {
  /** "Source N" (or the true name for the platform owner); a channel's own label otherwise. */
  label: (slug: string) => string;
  description: (slug: string) => string;
  /** A sentence with every vendor name replaced by what this viewer may read. */
  text: (s: string) => string;
  platformOwner: boolean;
  list: SourceName[];
};

const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(ARE_SOURCES.map((s) => [s.id, s.label]));
const CHANNEL_DESCRIPTION: Record<string, string> = Object.fromEntries(ARE_SOURCES.map((s) => [s.id, s.description]));

/** The namer for a loaded (or not yet loaded) list. Pure, for tests and the hook alike. */
export function makeSourceNamer(data: { platformOwner: boolean; sources: SourceName[] } | undefined): SourceNamer {
  const list = data?.sources ?? [];
  const bySlug = new Map(list.map((s) => [s.slug, s]));
  const platformOwner = !!data?.platformOwner;
  return {
    platformOwner,
    list,
    label: (slug) => {
      if (!isProspectDatabase(slug)) return CHANNEL_LABEL[slug] ?? slug;
      // Until the names arrive, a prospect database is just "a source": never its vendor.
      return bySlug.get(slug)?.label ?? "Prospect source";
    },
    description: (slug) => {
      if (!isProspectDatabase(slug)) return CHANNEL_DESCRIPTION[slug] ?? "";
      return bySlug.get(slug)?.description ?? "";
    },
    text: (s) => {
      if (platformOwner) return s;
      const vendors = list.length
        ? list.map((n) => ({ slug: n.slug, label: n.label }))
        : PROSPECT_DATABASE_SLUGS.map((slug) => ({ slug, label: "a prospect source" }));
      return anonymizeVendorText(s, vendors);
    },
  };
}

export function useSourceNames(): SourceNamer {
  const q = trpc.prospectSources.names.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  return makeSourceNamer(q.data);
}
