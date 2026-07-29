/**
 * Guard for a documented, recurring bug class in this repo:
 *
 *   "a client mutation with no error handling fails completely silently."
 *
 * There is no global error handler for mutations — the only cache-level
 * subscriber in main.tsx redirects on UNAUTHORIZED and does nothing else. So a
 * `useMutation` with no `onError`, whose caller does not handle the rejection
 * either, produces exactly nothing on failure: no toast, no console entry, no
 * changed pixel. The dropdown snaps back, the row does not save, and the user
 * is left to conclude the app is broken in a way they cannot describe. That is
 * the single most common complaint about this product from its own owner.
 *
 * The obvious fix does NOT work and should not be attempted again: tRPC v11's
 * useMutation installs its own onError wrapper, so `mutation.options.onError`
 * is always truthy and a cache-level "only toast when unhandled" guard can
 * never tell a handled mutation from an unhandled one. Handling has to be
 * declared at the site.
 *
 * The rule this test enforces is therefore deliberately blunt: every
 * `useMutation(` must EITHER
 *   - pass `onError` in its options (the house convention, ~320 sites), OR
 *   - pass `meta: { silentError: true }` to declare the silence on purpose
 *     (telemetry and optimistic read-state writes), OR
 *   - be listed in HANDLED_ELSEWHERE below, for the sites that handle the
 *     error at the `.mutate()` call site, in a try/catch around
 *     `mutateAsync`, or by rendering `x.error` in JSX.
 *
 * The third bucket is an explicit list rather than a heuristic on purpose. A
 * test that infers "this looks handled" using the same reasoning that
 * classified the code in the first place agrees with itself by construction —
 * the mirror-test trap that let chatFunnel.test.ts pass while the shipped
 * split was wrong. Each exception here is named, and the third test below
 * fails if an entry stops matching, so the list cannot quietly rot.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");

/**
 * Sites that handle mutation errors somewhere other than the options object.
 * Key is `<path relative to client/src>::<trpc procedure>`.
 */
const HANDLED_ELSEWHERE = new Set<string>([
  // Hook exposes `logoutMutation.error` in its public state (useAuth.ts:48).
  "_core/hooks/useAuth.ts::auth.logout",

  // Settings sections: awaited in a try/catch whose catch toasts.
  "components/usip/settings/BrandingSection.tsx::settings.save",
  "components/usip/settings/BrandingSection.tsx::brandVoice.save",
  "components/usip/settings/BrandingSection.tsx::workspace.updateBranding",
  "components/usip/settings/GuidedMailboxSetup.tsx::sendingAccounts.testConfig",
  "components/usip/settings/SocialAccountsSection.tsx::unipile.generateConnectLink",
  "components/usip/settings/SocialAccountsSection.tsx::unipile.disconnectAccount",
  "pages/usip/SettingsHub.tsx::profile.updateMe",
  "pages/usip/SettingsHub.tsx::settings.save",

  // Public, visitor-facing pages. These render the failure INLINE next to the
  // form (`book.error && <p>…`) rather than as a toast, which is right: a
  // stranger mid-booking should see the problem where they are looking, and a
  // raw tRPC message thrown over the page is not the register to address them
  // in. Do not "fix" these by adding a toast — it would double-report.
  "pages/BookingPage.tsx::bookingLinks.book",
  "pages/LandingPage.tsx::landingPages.submit",
  "pages/PublicForm.tsx::forms.submit",
  "pages/ChatPage.tsx::chatAgents.send",
  "pages/ChatPage.tsx::chatAgents.book",

  // Per-call onError at each .mutate() site (different message per action).
  "pages/usip/Mindmaps.tsx::mindmaps.create",
  "pages/usip/Mindmaps.tsx::mindmaps.rename",
  "pages/usip/Mindmaps.tsx::mindmaps.delete",
  "pages/usip/MindmapCanvas.tsx::mindmaps.createLinkedTask",
  "pages/usip/MindmapCanvas.tsx::mindmaps.createLinkedNote",

  // Awaited in a try/catch whose catch toasts.
  "pages/usip/MindmapCanvas.tsx::mindmaps.saveCanvas",
  "pages/usip/ARECampaignDetail.tsx::are.campaigns.update",
  "pages/usip/ARECampaignDetail.tsx::are.prospects.editSequenceStep",
  "pages/usip/ARECampaignDetail.tsx::are.engine.runOnce",
  "pages/usip/ConnectedAccounts.tsx::unipile.generateConnectLink",
  "pages/usip/EmailBuilder.tsx::emailTemplates.save",
  "pages/usip/ImportContacts.tsx::imports.parseCSV",
  "pages/usip/ImportContacts.tsx::imports.validateRows",
  "pages/usip/ImportContacts.tsx::imports.commit",
  "pages/usip/LinkedInEnrichmentImport.tsx::linkedinEnrichment.confirmEnrich",
  "pages/usip/LinkedInEnrichmentImport.tsx::linkedinEnrichment.resolveJobItem",
  "pages/usip/Personas.tsx::personas.create",
  "pages/usip/Personas.tsx::personas.update",
  "pages/usip/Personas.tsx::personas.delete",
  "pages/usip/Personas.tsx::personas.createFromPreset",
  "pages/usip/Personas.tsx::personas.createCategory",
  "pages/usip/Personas.tsx::personas.updateCategory",
  "pages/usip/Personas.tsx::personas.deleteCategory",
  "pages/usip/Personas.tsx::personas.reorderCategories",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Index of the ')' matching the '(' at openIdx, skipping strings + comments. */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++;
        i++;
      }
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    } else if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

interface Site {
  rel: string;
  line: number;
  proc: string;
  key: string;
  declaresHandling: boolean;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(CLIENT)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(CLIENT.length + 1).split(sep).join("/");
    const re = /useMutation\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = m.index + "useMutation".length;
      const close = matchParen(src, open);
      if (close < 0) continue;
      const options = src.slice(open + 1, close);
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      const proc = (before.match(/trpc\.([A-Za-z0-9_.]+)\.$/) || [])[1] ?? "(unknown)";
      sites.push({
        rel,
        line: src.slice(0, m.index).split("\n").length,
        proc,
        key: `${rel}::${proc}`,
        declaresHandling:
          /\bonError\s*:/.test(options) ||
          /\bmeta\s*:\s*\{[^}]*\bsilentError\s*:\s*true/.test(options),
      });
    }
  }
  return sites;
}

describe("client mutations always report their failures", () => {
  const sites = collectSites();

  it("finds the mutation sites at all (guards the scanner itself)", () => {
    // If a refactor changes how mutations are declared, this test would
    // silently pass by finding nothing. Pin a floor.
    expect(sites.length).toBeGreaterThan(400);
  });

  it("every useMutation declares onError, declares silence, or is a named exception", () => {
    const offenders = sites
      .filter((s) => !s.declaresHandling)
      .filter((s) => !HANDLED_ELSEWHERE.has(s.key))
      .map((s) => `${s.rel}:${s.line}  ${s.proc}`);

    expect(
      offenders,
      offenders.length
        ? `\n\n${offenders.length} mutation(s) fail silently. Add one of:\n` +
            `  onError: (e) => toast.error(e.message),        <- the house convention\n` +
            `  meta: { silentError: true },                   <- telemetry/optimistic writes only, say why in a comment\n` +
            `…or add it to HANDLED_ELSEWHERE in this file if the error is handled at the\n` +
            `call site, in a try/catch around mutateAsync, or rendered as x.error in JSX.\n\n` +
            offenders.join("\n") +
            "\n"
        : undefined,
    ).toEqual([]);
  });

  it("has no stale entries in HANDLED_ELSEWHERE", () => {
    // An allowlist with no staleness check is the "attempt marker that records
    // we tried but not with what" bug class: entries outlive the code they
    // excuse, and the next silent mutation inherits an exemption nobody meant
    // to grant.
    const live = new Set(sites.filter((s) => !s.declaresHandling).map((s) => s.key));
    const stale = [...HANDLED_ELSEWHERE].filter((k) => !live.has(k));
    expect(
      stale,
      stale.length
        ? `\n\nThese HANDLED_ELSEWHERE entries no longer match any unhandled mutation.\n` +
            `Either the site gained its own onError (drop the entry) or it moved/was\n` +
            `renamed (update it):\n\n${stale.join("\n")}\n`
        : undefined,
    ).toEqual([]);
  });
});
