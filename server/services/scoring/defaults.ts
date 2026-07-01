/**
 * Starter score-model templates. installDefaultModels() creates the two
 * reference models from the spec ("AI Automation Buyer Persona" for people,
 * "Mid-Market Service Buyer" for companies), wires their criteria groups +
 * criteria, and marks them primary + active. Idempotent by name per workspace.
 *
 * Field names/values map onto real Velocity columns (prospects.title/seniority/
 * functional_area, accounts.employeeBand/revenueBand/region, etc.); admins tune
 * them in the builder. Mutually-exclusive criteria are grouped by their group
 * (one winner per group), so no explicit category_key is needed.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { scoreModels } from "../../../drizzle/schema";
import {
  createScoreModel, createCriteriaGroup, createCriterion, setPrimaryScoreModel,
} from "./modelService";
import type { CriterionType } from "./types";

interface Spec {
  field: string; op: string; value: unknown; points: number; type: CriterionType;
  neg?: boolean; disq?: boolean; expl?: string;
}

async function buildModel(
  ws: number, userId: number, name: string, description: string,
  objectType: "person" | "company",
  groups: Array<{ name: string; maxPoints: number; specs: Spec[] }>,
  force = false,
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const existing = await db.select({ id: scoreModels.id, status: scoreModels.status }).from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.name, name)));
  const live = existing.filter((m) => m.status !== "archived");
  if (live.length && !force) return live[0].id;
  // force: archive prior same-name models so the fresh one becomes primary.
  for (const m of live) {
    await db.update(scoreModels).set({ status: "archived", isPrimary: false, archivedAt: new Date() } as never)
      .where(eq(scoreModels.id, m.id));
  }

  const modelId = await createScoreModel({ workspaceId: ws, createdByUserId: userId, name, description, objectType, modelType: "custom", impactMode: "label" });
  let order = 0;
  for (const g of groups) {
    const groupId = await createCriteriaGroup({ workspaceId: ws, scoreModelId: modelId, name: g.name, maxPoints: g.maxPoints, orderIndex: order++ });
    let cOrder = 0;
    for (const s of g.specs) {
      await createCriterion(ws, modelId, {
        groupId, fieldName: s.field, operator: s.op, valueJson: s.value, points: s.points,
        criterionType: s.type, isNegative: s.neg, isDisqualifier: s.disq,
        explanationTemplate: s.expl, orderIndex: cOrder++,
      });
    }
  }
  await setPrimaryScoreModel(ws, modelId);
  return modelId;
}

export async function installDefaultModels(
  ws: number, userId: number, force = false,
): Promise<{ personModelId: number | null; companyModelId: number | null }> {
  // Role/seniority use word-boundary regex so "IT" doesn't match "digital" and
  // seniority is derived from the title (the seniority/functional_area columns
  // are frequently unpopulated). Mutually-exclusive so one seniority tier wins.
  const personModelId = await buildModel(
    ws, userId, "AI Automation Buyer Persona",
    "Prioritizes senior IT / operations / transformation buyers by title and industry.",
    "person",
    [
      { name: "Seniority (from title)", maxPoints: 20, specs: [
        { field: "title", op: "regex_match", value: "\\b(cto|cio|ceo|coo|chief|founder|owner|president)\\b", points: 20, type: "mutually_exclusive", expl: "C-suite / founder / owner" },
        { field: "title", op: "regex_match", value: "\\b(vp|svp|evp|vice\\s?president)\\b", points: 18, type: "mutually_exclusive", expl: "VP-level" },
        { field: "title", op: "regex_match", value: "\\bdirector\\b", points: 15, type: "mutually_exclusive", expl: "Director-level" },
        { field: "title", op: "regex_match", value: "\\b(head|lead|principal)\\b", points: 12, type: "mutually_exclusive", expl: "Head / Lead / Principal" },
        { field: "title", op: "regex_match", value: "\\bmanager\\b", points: 8, type: "mutually_exclusive", expl: "Manager-level" },
      ] },
      { name: "Role / function fit", maxPoints: 30, specs: [
        { field: "title", op: "regex_match", value: "\\b(it|information technology|infosec|security|cloud|infrastructure|systems|network)\\b", points: 12, type: "stackable", expl: "IT / infrastructure / security role" },
        { field: "title", op: "regex_match", value: "\\b(operations|revops|revenue operations)\\b", points: 12, type: "stackable", expl: "Operations / RevOps role" },
        { field: "title", op: "regex_match", value: "\\b(digital|transformation|automation|ai|data)\\b", points: 12, type: "stackable", expl: "Digital / transformation / AI role" },
        { field: "title", op: "regex_match", value: "\\b(engineer|architect)\\b", points: 6, type: "stackable", expl: "Engineering / architecture role" },
      ] },
      { name: "Industry fit", maxPoints: 20, specs: [
        { field: "industry", op: "contains", value: "Information Technology", points: 15, type: "stackable", expl: "Works in Information Technology" },
        { field: "industry", op: "contains", value: "Software", points: 12, type: "stackable", expl: "Works in Software" },
        { field: "industry", op: "contains", value: "Security", points: 10, type: "stackable", expl: "Works in Security" },
        { field: "industry", op: "contains", value: "Defense", points: 10, type: "stackable", expl: "Works in Defense" },
      ] },
      { name: "Data / contactability", maxPoints: 20, specs: [
        { field: "has_verified_email", op: "equals", value: true, points: 8, type: "stackable", expl: "Verified email on file" },
        { field: "has_linkedin", op: "equals", value: true, points: 4, type: "stackable", expl: "LinkedIn URL on file" },
        { field: "has_current_title", op: "equals", value: true, points: 4, type: "stackable", expl: "Current title present" },
        { field: "has_company_domain", op: "equals", value: true, points: 4, type: "stackable", expl: "Company domain present" },
        { field: "is_hard_bounced", op: "equals", value: true, points: -20, type: "negative", neg: true, expl: "Email hard-bounced" },
        { field: "is_suppressed", op: "equals", value: true, points: 0, type: "disqualifier", disq: true, expl: "Suppressed / unsubscribed" },
      ] },
    ],
    force,
  );

  const companyModelId = await buildModel(
    ws, userId, "Mid-Market Service Buyer",
    "Prioritizes mid-market credit unions, gov contractors and higher-ed with modern-fit signals.",
    "company",
    [
      { name: "Industry fit", maxPoints: 20, specs: [
        { field: "industry", op: "contains", value: "Credit Union", points: 20, type: "stackable", expl: "Credit union" },
        { field: "industry", op: "contains", value: "Government", points: 20, type: "stackable", expl: "Government / contractor" },
        { field: "industry", op: "contains", value: "Education", points: 15, type: "stackable", expl: "Higher education" },
        { field: "industry", op: "contains", value: "Nonprofit", points: 15, type: "stackable", expl: "Nonprofit / foundation" },
      ] },
      { name: "Company size", maxPoints: 20, specs: [
        { field: "employee_band", op: "in", value: ["51-200", "201-500", "51-500"], points: 20, type: "mutually_exclusive", expl: "51–500 employees" },
        { field: "employee_band", op: "in", value: ["11-50"], points: 8, type: "mutually_exclusive", expl: "11–50 employees" },
        { field: "employee_band", op: "in", value: ["501-1000"], points: 15, type: "mutually_exclusive", expl: "501–1000 employees" },
        { field: "employee_band", op: "in", value: ["1-5", "1-10"], points: -10, type: "negative", neg: true, expl: "Very small (≤10 employees)" },
      ] },
      { name: "Revenue / budget", maxPoints: 15, specs: [
        { field: "revenue_band", op: "in", value: ["10M-50M", "50M-250M", "$10M-$50M", "$50M-$250M"], points: 15, type: "mutually_exclusive", expl: "$10M–$250M revenue" },
        { field: "revenue_band", op: "in", value: ["1M-10M", "$1M-$10M"], points: 5, type: "mutually_exclusive", expl: "$1M–$10M revenue" },
      ] },
      { name: "Technology stack", maxPoints: 15, specs: [
        { field: "technologies", op: "contains", value: "salesforce", points: 8, type: "stackable", expl: "Uses Salesforce" },
        { field: "technologies", op: "contains", value: "wordpress", points: 5, type: "stackable", expl: "Uses WordPress" },
        { field: "technologies", op: "contains", value: "blackbaud", points: 10, type: "stackable", expl: "Uses Blackbaud" },
      ] },
      { name: "Growth / intent", maxPoints: 20, specs: [
        { field: "hiring_signals", op: "contains", value: "ai", points: 15, type: "stackable", expl: "Hiring for AI / data roles" },
        { field: "hiring_signals", op: "contains", value: "digital", points: 10, type: "stackable", expl: "Hiring for digital roles" },
        { field: "website_keywords", op: "exists", value: true, points: 10, type: "stackable", expl: "Relevant website / intent signal" },
      ] },
      { name: "Location", maxPoints: 10, specs: [
        { field: "region", op: "contains", value: "United States", points: 5, type: "mutually_exclusive", expl: "United States" },
        { field: "is_competitor", op: "exists", value: true, points: 0, type: "disqualifier", disq: true, expl: "Competitor" },
      ] },
    ],
    force,
  );

  return { personModelId, companyModelId };
}
