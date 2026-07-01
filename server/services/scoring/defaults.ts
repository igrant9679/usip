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
  neg?: boolean; disq?: boolean;
}

async function buildModel(
  ws: number, userId: number, name: string, description: string,
  objectType: "person" | "company",
  groups: Array<{ name: string; maxPoints: number; specs: Spec[] }>,
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const existing = await db.select({ id: scoreModels.id }).from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.name, name))).limit(1);
  if (existing.length) return existing[0].id;

  const modelId = await createScoreModel({ workspaceId: ws, createdByUserId: userId, name, description, objectType, modelType: "custom", impactMode: "label" });
  let order = 0;
  for (const g of groups) {
    const groupId = await createCriteriaGroup({ workspaceId: ws, scoreModelId: modelId, name: g.name, maxPoints: g.maxPoints, orderIndex: order++ });
    let cOrder = 0;
    for (const s of g.specs) {
      await createCriterion(ws, modelId, {
        groupId, fieldName: s.field, operator: s.op, valueJson: s.value, points: s.points,
        criterionType: s.type, isNegative: s.neg, isDisqualifier: s.disq, orderIndex: cOrder++,
      });
    }
  }
  await setPrimaryScoreModel(ws, modelId);
  return modelId;
}

export async function installDefaultModels(ws: number, userId: number): Promise<{ personModelId: number | null; companyModelId: number | null }> {
  const personModelId = await buildModel(
    ws, userId, "AI Automation Buyer Persona",
    "Prioritizes operations / IT / transformation leaders who match a strong-fit account.",
    "person",
    [
      { name: "Role / title fit", maxPoints: 30, specs: [
        { field: "title", op: "contains", value: "Operations", points: 15, type: "stackable" },
        { field: "title", op: "contains", value: "Digital Transformation", points: 20, type: "stackable" },
        { field: "title", op: "contains", value: "IT", points: 10, type: "stackable" },
        { field: "title", op: "contains", value: "RevOps", points: 10, type: "stackable" },
      ] },
      { name: "Seniority fit", maxPoints: 20, specs: [
        { field: "seniority", op: "contains", value: "Director", points: 15, type: "mutually_exclusive" },
        { field: "seniority", op: "contains", value: "VP", points: 20, type: "mutually_exclusive" },
        { field: "seniority", op: "contains", value: "C-Level", points: 20, type: "mutually_exclusive" },
        { field: "seniority", op: "contains", value: "Manager", points: 8, type: "mutually_exclusive" },
      ] },
      { name: "Department fit", maxPoints: 15, specs: [
        { field: "functional_area", op: "contains", value: "Operations", points: 10, type: "mutually_exclusive" },
        { field: "functional_area", op: "contains", value: "IT", points: 10, type: "mutually_exclusive" },
      ] },
      { name: "Company fit overlay", maxPoints: 20, specs: [
        { field: "company_fit_rating", op: "equals", value: "excellent", points: 20, type: "mutually_exclusive" },
        { field: "company_fit_rating", op: "equals", value: "good", points: 12, type: "mutually_exclusive" },
        { field: "company_fit_rating", op: "equals", value: "fair", points: 5, type: "mutually_exclusive" },
      ] },
      { name: "Data / contactability", maxPoints: 15, specs: [
        { field: "has_verified_email", op: "equals", value: true, points: 8, type: "stackable" },
        { field: "has_linkedin", op: "equals", value: true, points: 3, type: "stackable" },
        { field: "has_current_title", op: "equals", value: true, points: 3, type: "stackable" },
        { field: "is_hard_bounced", op: "equals", value: true, points: -20, type: "negative", neg: true },
        { field: "is_suppressed", op: "equals", value: true, points: 0, type: "disqualifier", disq: true },
      ] },
    ],
  );

  const companyModelId = await buildModel(
    ws, userId, "Mid-Market Service Buyer",
    "Prioritizes mid-market credit unions, gov contractors and higher-ed with modern-fit signals.",
    "company",
    [
      { name: "Industry fit", maxPoints: 20, specs: [
        { field: "industry", op: "contains", value: "Credit Union", points: 20, type: "stackable" },
        { field: "industry", op: "contains", value: "Government", points: 20, type: "stackable" },
        { field: "industry", op: "contains", value: "Education", points: 15, type: "stackable" },
        { field: "industry", op: "contains", value: "Nonprofit", points: 15, type: "stackable" },
      ] },
      { name: "Company size", maxPoints: 20, specs: [
        { field: "employee_band", op: "in", value: ["51-200", "201-500", "51-500"], points: 20, type: "mutually_exclusive" },
        { field: "employee_band", op: "in", value: ["11-50"], points: 8, type: "mutually_exclusive" },
        { field: "employee_band", op: "in", value: ["501-1000"], points: 15, type: "mutually_exclusive" },
        { field: "employee_band", op: "in", value: ["1-5", "1-10"], points: -10, type: "negative", neg: true },
      ] },
      { name: "Revenue / budget", maxPoints: 15, specs: [
        { field: "revenue_band", op: "in", value: ["10M-50M", "50M-250M", "$10M-$50M", "$50M-$250M"], points: 15, type: "mutually_exclusive" },
        { field: "revenue_band", op: "in", value: ["1M-10M", "$1M-$10M"], points: 5, type: "mutually_exclusive" },
      ] },
      { name: "Technology stack", maxPoints: 15, specs: [
        { field: "technologies", op: "contains", value: "salesforce", points: 8, type: "stackable" },
        { field: "technologies", op: "contains", value: "wordpress", points: 5, type: "stackable" },
        { field: "technologies", op: "contains", value: "blackbaud", points: 10, type: "stackable" },
      ] },
      { name: "Growth / intent", maxPoints: 20, specs: [
        { field: "hiring_signals", op: "contains", value: "ai", points: 15, type: "stackable" },
        { field: "hiring_signals", op: "contains", value: "digital", points: 10, type: "stackable" },
        { field: "website_keywords", op: "exists", value: true, points: 10, type: "stackable" },
      ] },
      { name: "Location", maxPoints: 10, specs: [
        { field: "region", op: "contains", value: "United States", points: 5, type: "mutually_exclusive" },
        { field: "is_competitor", op: "exists", value: true, points: 0, type: "disqualifier", disq: true },
      ] },
    ],
  );

  return { personModelId, companyModelId };
}
