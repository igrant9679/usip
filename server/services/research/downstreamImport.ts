/**
 * Importing a Downstream export into Research (Research module, phase 5).
 *
 * Preview, then commit (the prospectImports pattern): preview parses the file
 * (shared/downstreamContract: limits, personal-data scrub), checks it is
 * linked to THIS workspace, and says for every segment, persona and the market
 * whether it is new, updated, unchanged, edited in Velocity since the last
 * import (a conflict), or deleted here. The token is bound to the workspace
 * and the person, and lasts 15 minutes. Commit writes only what the person
 * ticked, through the Research store, so every change is a version.
 *
 * Rules (Downstream's docs/velocity-integration.md, kept):
 *   - a file imports only into a workspace linked to its Downstream
 *     workspace; nothing is shared between Velocity workspaces;
 *   - seller layers only when the file is a seller export AND the link says
 *     it is this company's; otherwise they are not stored at all;
 *   - re-importing the same file changes nothing; a record someone edited in
 *     Velocity is kept unless they choose Downstream's version;
 *   - nothing is sent, launched or activated by an import.
 */
import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { accounts, downstreamLinks, personaCategories, personas, researchExternalRefs, researchMarkets, researchSectors } from "../../../drizzle/schema";
import { normalizedAccountFields, normalizeDomain } from "../company/normalize";
import { matchAccount } from "./downstreamAccounts";
import {
  insertMarket,
  insertSector,
  marketContentOf,
  saveMarket,
  saveSector,
  sectorContentOf,
  type Db,
} from "./store";
import { parseDownstreamFile, type DownstreamFile, type DownstreamSegment } from "@shared/downstreamContract";
import {
  accountFromDownstream,
  cleanLinkSettings,
  effectiveDownstreamTargeting,
  knowledgeToMarket,
  marketExtras,
  personaFromDownstream,
  segmentToSector,
  sellerAllowed,
  type DownstreamLinkSettings,
  type ImportedPersona,
} from "@shared/downstreamMap";
import { cleanPersonaResearch } from "@shared/researchShape";
import { icpLabels } from "@shared/icpShape";
import { RESEARCH_SOURCES } from "@shared/researchSource";
import { markDownstreamAccounts } from "./accountSource";

export type ItemState = "new" | "updated" | "unchanged" | "conflict" | "deleted";

// Keys sorted, so a value read back from MySQL (which reorders JSON object
// keys) hashes the same as the value that was written.
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" && !(v instanceof Date)
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
    : v;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(sorted(v))).digest("hex");

export function normalizeSourceUrl(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/* ── Drafts (preview tokens) ────────────────────────────────────────────── */

const TTL_MS = 15 * 60 * 1000;
type Draft = { workspaceId: number; userId: number; createdAt: number; file: DownstreamFile; fileHash: string; dropped: string[] };
const drafts = new Map<string, Draft>();

function sweep(now = Date.now()) {
  for (const [k, d] of Array.from(drafts.entries())) if (now - d.createdAt > TTL_MS) drafts.delete(k);
}

export function __clearDownstreamDrafts() {
  drafts.clear();
}

/* ── Reading what is there ──────────────────────────────────────────────── */

type Link = typeof downstreamLinks.$inferSelect;
type Ref = typeof researchExternalRefs.$inferSelect;

async function findLink(db: Db, workspaceId: number, file: DownstreamFile): Promise<{ link: Link | null; moved: Link | null }> {
  const rows = await db
    .select()
    .from(downstreamLinks)
    .where(and(eq(downstreamLinks.workspaceId, workspaceId), eq(downstreamLinks.downstreamWorkspaceId, file.source.workspace.id)));
  const url = normalizeSourceUrl(file.source.url);
  const link = rows.find((r) => r.sourceUrl === url) ?? null;
  return { link, moved: link ? null : rows[0] ?? null };
}

async function refsOf(db: Db, workspaceId: number, linkId: number): Promise<Map<string, Ref>> {
  const rows = await db
    .select()
    .from(researchExternalRefs)
    .where(and(eq(researchExternalRefs.workspaceId, workspaceId), eq(researchExternalRefs.linkId, linkId)));
  return new Map(rows.map((r) => [`${r.kind}:${r.ref}`, r]));
}

const personaShape = (p: Record<string, any>): ImportedPersona => {
  const r = cleanPersonaResearch(p).content;
  return {
    name: String(p.name ?? ""),
    targetTitles: icpLabels(p.targetTitles, "title"),
    targetIndustries: icpLabels(p.targetIndustries, "industry"),
    targetGeographies: icpLabels(p.targetGeographies, "geography"),
    keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
    employeeMin: p.employeeMin ?? null,
    employeeMax: p.employeeMax ?? null,
    cares: r.cares,
    pains: r.pains,
    objections: r.objections,
    angle: r.angle,
    suggested: false,
  };
};
const personaHash = (p: ImportedPersona) => hash({ ...p, suggested: false });

async function stateOf(db: Db, workspaceId: number, kind: "market" | "sector" | "persona", ref: Ref | undefined, newHash: string): Promise<ItemState> {
  if (!ref) return "new";
  if (kind === "market" || kind === "sector") {
    const table = kind === "market" ? researchMarkets : researchSectors;
    const [row] = await db
      .select({ revision: table.revision })
      .from(table)
      .where(and(eq(table.id, ref.velocityId), eq(table.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return "deleted";
    if (ref.contentHash === newHash) return "unchanged";
    return row.revision === ref.writtenRevision ? "updated" : "conflict";
  }
  const [row] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, ref.velocityId), eq(personas.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return "deleted";
  if (ref.contentHash === newHash) return "unchanged";
  return personaHash(personaShape(row)) === ref.contentHash ? "updated" : "conflict";
}

/* ── Preview ────────────────────────────────────────────────────────────── */

export type DownstreamPreview = {
  token: string;
  source: { url: string; workspaceId: string; workspaceName: string; kind: string; exportedAt: string; exportedBy: string };
  audience: "seller" | "market";
  sellerName: string | null;
  intendedFor: string | null;
  intendedForMismatch: boolean;
  link: { state: "assigned" | "unassigned" | "moved"; id: number | null; status: string | null; useSellerMessaging: boolean; settings: DownstreamLinkSettings };
  market: { state: ItemState };
  segments: {
    ref: string;
    name: string;
    shortName: string;
    status: string;
    revision: number;
    state: ItemState;
    ticked: boolean;
    titles: string[];
    exclude: string[];
    personas: { ref: string; name: string; state: ItemState; suggested: boolean }[];
    organizations: number;
  }[];
  knowledge: { glossary: number; competitors: number; funders: number };
  hasStats: boolean;
  organizationsTotal: number;
  droppedPersonal: number;
};

export async function previewDownstream(db: Db, workspaceId: number, userId: number, workspaceName: string, text: string): Promise<DownstreamPreview> {
  const parsed = parseDownstreamFile(text);
  if (!parsed.ok) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error });
  const file = parsed.file;
  sweep();
  const token = randomUUID();
  drafts.set(token, { workspaceId, userId, createdAt: Date.now(), file, fileHash: hash(text), dropped: parsed.dropped });

  const { link, moved } = await findLink(db, workspaceId, file);
  const settings = cleanLinkSettings(link?.settings);
  const useSeller = link?.useSellerMessaging ?? false;
  const seller = sellerAllowed(file, useSeller);
  const refs = link ? await refsOf(db, workspaceId, link.id) : new Map<string, Ref>();
  const ticked = new Set(link ? settings.segments : []);

  const unticked = file.segments.filter((s) => !ticked.has(s.ref));
  const marketHash = hash(knowledgeToMarket(file, unticked));
  const segments: DownstreamPreview["segments"] = [];
  for (const seg of file.segments) {
    const content = segmentToSector(seg, settings, seller);
    const segPersonas = file.personas.filter((p) => p.segmentRef === seg.ref);
    const personasOut: DownstreamPreview["segments"][number]["personas"] = [];
    for (const p of segPersonas) {
      const mapped = personaFromDownstream(p, content.targeting, settings);
      personasOut.push({ ref: p.ref, name: p.name, suggested: mapped.suggested, state: await stateOf(db, workspaceId, "persona", refs.get(`persona:${p.ref}`), personaHash(mapped)) });
    }
    segments.push({
      ref: seg.ref,
      name: seg.name,
      shortName: seg.shortName,
      status: seg.research.status,
      revision: seg.revision,
      state: await stateOf(db, workspaceId, "sector", refs.get(`sector:${seg.ref}`), hash(content)),
      ticked: ticked.has(seg.ref),
      titles: content.targeting.titles,
      exclude: content.targeting.exclude,
      personas: personasOut,
      organizations: file.organizations.filter((o) => o.segmentRef === seg.ref).length,
    });
  }
  const intendedFor = file.intendedFor?.trim() || null;
  return {
    token,
    source: {
      url: file.source.url,
      workspaceId: file.source.workspace.id,
      workspaceName: file.source.workspace.name,
      kind: file.source.workspace.kind,
      exportedAt: file.exportedAt,
      exportedBy: file.source.exportedBy,
    },
    audience: file.audience,
    sellerName: file.audience === "seller" ? file.seller?.name ?? null : null,
    intendedFor,
    intendedForMismatch: !!intendedFor && !workspaceName.toLowerCase().includes(intendedFor.toLowerCase()) && !intendedFor.toLowerCase().includes(workspaceName.toLowerCase()),
    link: {
      state: link ? "assigned" : moved ? "moved" : "unassigned",
      id: link?.id ?? moved?.id ?? null,
      status: (link ?? moved)?.status ?? null,
      useSellerMessaging: useSeller,
      settings,
    },
    market: { state: await stateOf(db, workspaceId, "market", refs.get(`market:${file.source.workspace.id}`), marketHash) },
    segments,
    knowledge: { glossary: file.knowledge?.glossary?.length ?? 0, competitors: file.knowledge?.competitors?.length ?? 0, funders: file.knowledge?.funders?.length ?? 0 },
    hasStats: !!file.marketStats,
    organizationsTotal: file.organizations.length,
    droppedPersonal: parsed.dropped.length,
  };
}

/* ── Commit ─────────────────────────────────────────────────────────────── */

export type DownstreamChoices = {
  token: string;
  /** Link the file's Downstream workspace to this workspace (first import). */
  assign?: boolean;
  /** Same Downstream workspace at a new address: move the link. */
  updateLinkUrl?: boolean;
  useSellerMessaging: boolean;
  /** Segment refs to import. */
  segments: string[];
  importOrganizations: boolean;
  /** Refs (sector, persona or the market's) whose Velocity edits or deletion should give way to Downstream's version. */
  takeDownstream: string[];
};

export type DownstreamCommitResult = {
  linkId: number;
  marketId: number;
  counts: { created: number; updated: number; unchanged: number; keptYours: number; accountsCreated: number; accountsMatched: number; accountsUpdated: number; accountsUnchanged: number };
};

async function upsertRef(db: Db, workspaceId: number, linkId: number, kind: Ref["kind"], ref: string, velocityId: number, revision: number | null, contentHash: string, writtenRevision: number | null, existing?: Ref) {
  if (existing) {
    await db
      .update(researchExternalRefs)
      .set({ velocityId, revision, contentHash, writtenRevision })
      .where(and(eq(researchExternalRefs.id, existing.id), eq(researchExternalRefs.workspaceId, workspaceId)));
  } else {
    await db.insert(researchExternalRefs).values({ workspaceId, linkId, kind, ref, velocityId, revision, contentHash, writtenRevision });
  }
}

async function revisionOf(db: Db, table: typeof researchMarkets | typeof researchSectors, id: number, workspaceId: number): Promise<number> {
  const [r] = await db.select({ revision: table.revision }).from(table).where(and(eq(table.id, id), eq(table.workspaceId, workspaceId))).limit(1);
  return r?.revision ?? 1;
}

export async function commitDownstream(db: Db, workspaceId: number, userId: number, isAdmin: boolean, choices: DownstreamChoices): Promise<DownstreamCommitResult> {
  sweep();
  const draft = drafts.get(choices.token);
  // A token from another workspace or person is the same as no token.
  if (!draft || draft.workspaceId !== workspaceId || draft.userId !== userId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "This preview has expired. Choose the file again." });
  }
  const file = draft.file;
  const ws = file.source.workspace;
  const now = new Date();

  // 1. The link.
  let { link, moved } = await findLink(db, workspaceId, file);
  if (!link) {
    if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can link a Downstream workspace to this workspace." });
    if (moved && choices.updateLinkUrl) {
      await db.update(downstreamLinks).set({ sourceUrl: normalizeSourceUrl(file.source.url) }).where(and(eq(downstreamLinks.id, moved.id), eq(downstreamLinks.workspaceId, workspaceId)));
      link = { ...moved, sourceUrl: normalizeSourceUrl(file.source.url) };
    } else if (!moved && choices.assign) {
      const [row] = await db
        .insert(downstreamLinks)
        .values({ workspaceId, sourceUrl: normalizeSourceUrl(file.source.url), downstreamWorkspaceId: ws.id, downstreamWorkspaceName: ws.name, kind: ws.kind, status: "active", useSellerMessaging: false, settings: {} })
        .$returningId();
      const [created] = await db.select().from(downstreamLinks).where(and(eq(downstreamLinks.id, row.id), eq(downstreamLinks.workspaceId, workspaceId))).limit(1);
      link = created;
    } else {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: moved
          ? `This is "${ws.name}" from Downstream at a new address. Choose "update the link" to import it.`
          : `"${ws.name}" from Downstream is not linked to this workspace. Choose "link it" to import it here.`,
      });
    }
  }
  if (!link) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  if (link.status === "paused") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This Downstream link is paused. Resume it to import." });

  const segmentRefs = new Set(choices.segments.filter((r) => file.segments.some((s) => s.ref === r)));
  const settings: DownstreamLinkSettings = { ...cleanLinkSettings(link.settings), segments: Array.from(segmentRefs) };
  const useSeller = file.audience === "seller" ? choices.useSellerMessaging : link.useSellerMessaging;
  const seller = sellerAllowed(file, useSeller);
  const take = new Set(choices.takeDownstream);
  const refs = await refsOf(db, workspaceId, link.id);
  const counts = { created: 0, updated: 0, unchanged: 0, keptYours: 0, accountsCreated: 0, accountsMatched: 0, accountsUpdated: 0, accountsUnchanged: 0 };
  const note = (rev: number) => `Downstream import (revision ${rev})`;

  // 2. The market.
  const unticked: DownstreamSegment[] = file.segments.filter((s) => !segmentRefs.has(s.ref));
  const marketContent = knowledgeToMarket(file, unticked);
  const extras = marketExtras(file, seller);
  const marketHash = hash(marketContent);
  const marketRef = refs.get(`market:${ws.id}`);
  const marketState = await stateOf(db, workspaceId, "market", marketRef, marketHash);
  let marketId: number;
  if (marketState === "new" || (marketState === "deleted" && take.has(ws.id))) {
    const taken = await db.select({ name: researchMarkets.name }).from(researchMarkets).where(eq(researchMarkets.workspaceId, workspaceId));
    const name = taken.some((m) => m.name.trim().toLowerCase() === marketContent.name.toLowerCase()) ? `${marketContent.name} (Downstream)` : marketContent.name;
    marketId = (await insertMarket(db, { workspaceId, userId, content: { ...marketContent, name }, source: "downstream", sourceRef: ws.id, note: "Imported from Downstream" })).id;
    counts.created++;
  } else if (marketState === "deleted") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The "${ws.name}" market was deleted in Velocity. Tick "use Downstream's version" for it to bring it back.` });
  } else {
    marketId = marketRef!.velocityId;
    if (marketState === "updated" || (marketState === "conflict" && take.has(ws.id))) {
      const [cur] = await db.select().from(researchMarkets).where(and(eq(researchMarkets.id, marketId), eq(researchMarkets.workspaceId, workspaceId))).limit(1);
      await saveMarket(db, { workspaceId, userId, id: marketId, expectedRevision: cur.revision, content: { ...marketContent, name: marketContentOf(cur).name, status: marketContentOf(cur).status }, note: "Downstream import" });
      counts.updated++;
    } else if (marketState === "conflict") counts.keptYours++;
    else counts.unchanged++;
  }
  // Statistics and funders are Downstream's alone: written whenever they changed.
  const [stored] = await db.select({ extras: researchMarkets.extras }).from(researchMarkets).where(and(eq(researchMarkets.id, marketId), eq(researchMarkets.workspaceId, workspaceId))).limit(1);
  if (hash(stored?.extras ?? null) !== hash(extras)) {
    await db.update(researchMarkets).set({ extras }).where(and(eq(researchMarkets.id, marketId), eq(researchMarkets.workspaceId, workspaceId)));
  }
  // The ref moves only when this import wrote the market. Unchanged or kept,
  // it stays as it was: its writtenRevision is what tells an edit made here
  // apart from Downstream's, so moving it would pass the edit off as theirs.
  if (marketState !== "unchanged" && (marketState !== "conflict" || take.has(ws.id))) {
    await upsertRef(db, workspaceId, link.id, "market", ws.id, marketId, null, marketHash, await revisionOf(db, researchMarkets, marketId, workspaceId), marketRef);
  }

  // 3. Sectors, for the ticked segments.
  const sectorIdByRef = new Map<string, number>();
  for (const seg of file.segments) {
    if (!segmentRefs.has(seg.ref)) continue;
    const content = segmentToSector(seg, settings, seller);
    const h = hash(content);
    const ref = refs.get(`sector:${seg.ref}`);
    const state = await stateOf(db, workspaceId, "sector", ref, h);
    let sectorId: number;
    if (state === "new" || (state === "deleted" && take.has(seg.ref))) {
      const siblings = await db.select({ name: researchSectors.name }).from(researchSectors).where(and(eq(researchSectors.workspaceId, workspaceId), eq(researchSectors.marketId, marketId)));
      const name = siblings.some((s) => s.name.trim().toLowerCase() === content.name.toLowerCase()) ? `${content.name} (Downstream)` : content.name;
      sectorId = (await insertSector(db, { workspaceId, userId, marketId, content: { ...content, name }, source: "downstream", sourceRef: seg.ref, note: `Imported from Downstream (revision ${seg.revision})` })).id;
      counts.created++;
    } else if (state === "deleted") {
      counts.keptYours++;
      continue;
    } else {
      sectorId = ref!.velocityId;
      if (state === "updated" || (state === "conflict" && take.has(seg.ref))) {
        const [cur] = await db.select().from(researchSectors).where(and(eq(researchSectors.id, sectorId), eq(researchSectors.workspaceId, workspaceId))).limit(1);
        await saveSector(db, { workspaceId, userId, id: sectorId, expectedRevision: cur.revision, content: { ...content, name: sectorContentOf(cur).name }, note: note(seg.revision) });
        counts.updated++;
      } else if (state === "conflict") {
        counts.keptYours++;
        sectorIdByRef.set(seg.ref, sectorId);
        continue; // keep the ref as it was, so the next import still sees the edit
      } else {
        counts.unchanged++;
        sectorIdByRef.set(seg.ref, sectorId);
        continue; // likewise: an edit made here since the last import stays an edit
      }
    }
    sectorIdByRef.set(seg.ref, sectorId);
    await upsertRef(db, workspaceId, link.id, "sector", seg.ref, sectorId, seg.revision, h, await revisionOf(db, researchSectors, sectorId, workspaceId), ref);
  }

  // 4. Personas of the ticked segments, in a category named after the Downstream workspace.
  const segPersonas = file.personas.filter((p) => segmentRefs.has(p.segmentRef) && sectorIdByRef.has(p.segmentRef));
  let categoryId: number | null = null;
  if (segPersonas.length) {
    const catName = `Downstream: ${ws.name}`.slice(0, 120);
    const [cat] = await db.select({ id: personaCategories.id }).from(personaCategories).where(and(eq(personaCategories.workspaceId, workspaceId), eq(personaCategories.name, catName))).limit(1);
    categoryId = cat?.id ?? (await db.insert(personaCategories).values({ workspaceId, name: catName, sortOrder: 999 }).$returningId())[0].id;
  }
  for (const p of segPersonas) {
    const seg = file.segments.find((s) => s.ref === p.segmentRef)!;
    const mapped = personaFromDownstream(p, effectiveDownstreamTargeting(seg.targeting, settings), settings);
    const h = personaHash(mapped);
    const ref = refs.get(`persona:${p.ref}`);
    const state = await stateOf(db, workspaceId, "persona", ref, h);
    const values = {
      name: mapped.name,
      targetTitles: mapped.targetTitles,
      targetIndustries: mapped.targetIndustries,
      targetGeographies: mapped.targetGeographies,
      keywords: mapped.keywords,
      employeeMin: mapped.employeeMin,
      employeeMax: mapped.employeeMax,
      cares: mapped.cares || null,
      pains: mapped.pains,
      objections: mapped.objections,
      angle: mapped.angle || null,
      sectorId: sectorIdByRef.get(p.segmentRef)!,
    };
    let personaId: number;
    if (state === "new" || (state === "deleted" && take.has(p.ref))) {
      personaId = (await db.insert(personas).values({ workspaceId, ...values, categoryId, source: "downstream", sourceRef: p.ref, createdByUserId: userId }).$returningId())[0].id;
      counts.created++;
    } else if (state === "deleted" || (state === "conflict" && !take.has(p.ref))) {
      counts.keptYours++;
      continue;
    } else {
      personaId = ref!.velocityId;
      if (state === "unchanged") counts.unchanged++;
      else {
        await db.update(personas).set(values).where(and(eq(personas.id, personaId), eq(personas.workspaceId, workspaceId)));
        counts.updated++;
      }
    }
    await upsertRef(db, workspaceId, link.id, "persona", p.ref, personaId, null, h, null, ref);
  }

  // 5. Organizations of the ticked segments, as accounts carrying their award.
  if (choices.importOrganizations) {
    for (const o of file.organizations) {
      if (!o.segmentRef || !segmentRefs.has(o.segmentRef)) continue;
      const mapped = accountFromDownstream(o, seller);
      const h = hash(mapped);
      const ref = refs.get(`account:${o.ref}`);
      if (ref && ref.contentHash === h) { counts.accountsUnchanged++; continue; }
      let accountId = ref?.velocityId ?? null;
      if (accountId != null) {
        const [still] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId))).limit(1);
        if (!still) accountId = null;
        else counts.accountsUpdated++;
      }
      if (accountId == null) {
        accountId = await matchAccount(db, workspaceId, { website: mapped.website, name: mapped.name, state: mapped.state });
        if (accountId != null) counts.accountsMatched++;
      }
      if (accountId == null) {
        const domain = normalizeDomain(mapped.website);
        accountId = (await db
          .insert(accounts)
          .values({
            workspaceId,
            name: mapped.name,
            domain: domain || undefined,
            websiteUrl: domain ? `https://${domain}` : undefined,
            hqState: mapped.state || undefined,
            ...normalizedAccountFields(mapped.name, domain),
            // Sourced by Research (2026-10-16), in the sector its segment became.
            sourceType: RESEARCH_SOURCES.downstream,
            researchSectorId: sectorIdByRef.get(o.segmentRef) ?? null,
          })
          .$returningId())[0].id;
        counts.accountsCreated++;
      }
      // Only the Downstream keys change; everything a person set stays.
      const [acct] = await db.select({ customFields: accounts.customFields }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId))).limit(1);
      const cf = { ...((acct?.customFields && typeof acct.customFields === "object" ? acct.customFields : {}) as Record<string, unknown>) };
      cf.downstreamRef = o.ref;
      cf.downstreamSegmentRef = mapped.segmentRef;
      cf.downstreamAward = mapped.award;
      cf.downstreamProfile = mapped.profile;
      if (mapped.fit) cf.downstreamFit = mapped.fit;
      else delete cf.downstreamFit;
      const program = mapped.award?.program?.trim();
      if (program) {
        const topics = Array.isArray(cf.intentTopics) ? (cf.intentTopics as unknown[]).map(String) : [];
        if (!topics.some((t) => t.toLowerCase() === program.toLowerCase())) cf.intentTopics = [...topics, program].slice(0, 30);
      }
      await db.update(accounts).set({ customFields: cf }).where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)));
      await upsertRef(db, workspaceId, link.id, "account", o.ref, accountId, o.revision ?? null, h, null, ref);
    }
  }

  // Companies from this link carry their research sector and, where the
  // import created them, the Research source (also catches earlier imports).
  await markDownstreamAccounts(db, workspaceId, link.id);

  // 6. The link remembers this import.
  await db
    .update(downstreamLinks)
    .set({
      settings,
      useSellerMessaging: useSeller,
      audience: file.audience,
      marketId,
      downstreamWorkspaceName: ws.name,
      lastImportAt: now,
      lastImportedByUserId: userId,
      lastFileHash: draft.fileHash,
      lastExportedAt: file.exportedAt.slice(0, 40),
    })
    .where(and(eq(downstreamLinks.id, link.id), eq(downstreamLinks.workspaceId, workspaceId)));
  drafts.delete(choices.token);
  return { linkId: link.id, marketId, counts };
}
