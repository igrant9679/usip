/**
 * Tests for SMTP config validation, nightly batch logic, and segment rule enrollment
 */
import { describe, expect, it } from "vitest";

/* ─── SMTP Config Validation ─────────────────────────────────────────────── */

function validateSmtpConfig(cfg: {
  host: string;
  port: number;
  username: string;
  fromEmail: string;
  secure?: boolean;
}) {
  const errors: string[] = [];
  if (!cfg.host || cfg.host.trim().length === 0) errors.push("host is required");
  if (!cfg.port || cfg.port < 1 || cfg.port > 65535) errors.push("port must be 1-65535");
  if (!cfg.username || cfg.username.trim().length === 0) errors.push("username is required");
  if (!cfg.fromEmail || !cfg.fromEmail.includes("@")) errors.push("fromEmail must be a valid email");
  return errors;
}

describe("SMTP config validation", () => {
  it("accepts a valid config", () => {
    const errors = validateSmtpConfig({
      host: "smtp.gmail.com",
      port: 587,
      username: "user@gmail.com",
      fromEmail: "user@gmail.com",
      secure: false,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects missing host", () => {
    const errors = validateSmtpConfig({ host: "", port: 587, username: "u@x.com", fromEmail: "u@x.com" });
    expect(errors).toContain("host is required");
  });

  it("rejects invalid port (0)", () => {
    const errors = validateSmtpConfig({ host: "smtp.x.com", port: 0, username: "u@x.com", fromEmail: "u@x.com" });
    expect(errors).toContain("port must be 1-65535");
  });

  it("rejects invalid port (99999)", () => {
    const errors = validateSmtpConfig({ host: "smtp.x.com", port: 99999, username: "u@x.com", fromEmail: "u@x.com" });
    expect(errors).toContain("port must be 1-65535");
  });

  it("rejects missing username", () => {
    const errors = validateSmtpConfig({ host: "smtp.x.com", port: 587, username: "", fromEmail: "u@x.com" });
    expect(errors).toContain("username is required");
  });

  it("rejects invalid fromEmail (no @)", () => {
    const errors = validateSmtpConfig({ host: "smtp.x.com", port: 587, username: "u@x.com", fromEmail: "notanemail" });
    expect(errors).toContain("fromEmail must be a valid email");
  });

  it("accepts port 465 with secure=true (TLS)", () => {
    const errors = validateSmtpConfig({ host: "smtp.gmail.com", port: 465, username: "u@x.com", fromEmail: "u@x.com", secure: true });
    expect(errors).toHaveLength(0);
  });
});

/* ─── Nightly Batch Lead Filtering ──────────────────────────────────────────── */

interface Lead {
  id: number;
  email: string | null;
  score: number;
}

interface PipelineJob {
  leadId: number;
  createdAt: Date;
}

function filterEligibleLeads(
  leads: Lead[],
  scoreThreshold: number,
  recentJobs: PipelineJob[],
  sevenDaysAgo: Date,
  maxPerWorkspace: number
): Lead[] {
  const recentLeadIds = new Set(
    recentJobs
      .filter((j) => j.createdAt >= sevenDaysAgo)
      .map((j) => j.leadId)
  );

  return leads
    .filter((l) => l.score >= scoreThreshold && l.email && l.email.trim() !== "")
    .filter((l) => !recentLeadIds.has(l.id))
    .slice(0, maxPerWorkspace);
}

describe("nightly batch — lead filtering", () => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
  const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

  const leads: Lead[] = [
    { id: 1, email: "a@x.com", score: 80 },
    { id: 2, email: "b@x.com", score: 70 },
    { id: 3, email: "c@x.com", score: 55 }, // below threshold
    { id: 4, email: null, score: 90 },       // no email
    { id: 5, email: "e@x.com", score: 75 },
  ];

  it("filters out leads below score threshold", () => {
    const result = filterEligibleLeads(leads, 60, [], sevenDaysAgo, 50);
    expect(result.find((l) => l.id === 3)).toBeUndefined();
  });

  it("filters out leads with no email", () => {
    const result = filterEligibleLeads(leads, 60, [], sevenDaysAgo, 50);
    expect(result.find((l) => l.id === 4)).toBeUndefined();
  });

  it("filters out leads with a recent pipeline job", () => {
    const recentJobs: PipelineJob[] = [{ leadId: 1, createdAt: recentDate }];
    const result = filterEligibleLeads(leads, 60, recentJobs, sevenDaysAgo, 50);
    expect(result.find((l) => l.id === 1)).toBeUndefined();
  });

  it("includes leads whose last job was more than 7 days ago", () => {
    const oldJobs: PipelineJob[] = [{ leadId: 1, createdAt: oldDate }];
    const result = filterEligibleLeads(leads, 60, oldJobs, sevenDaysAgo, 50);
    expect(result.find((l) => l.id === 1)).toBeDefined();
  });

  it("respects maxPerWorkspace cap", () => {
    const result = filterEligibleLeads(leads, 60, [], sevenDaysAgo, 2);
    expect(result).toHaveLength(2);
  });

  it("returns all eligible leads when under cap", () => {
    // leads 1, 2, 5 pass (score >= 60, have email)
    const result = filterEligibleLeads(leads, 60, [], sevenDaysAgo, 50);
    expect(result.map((l) => l.id).sort()).toEqual([1, 2, 5]);
  });
});

/* ─── Segment Rule Enrollment Logic ─────────────────────────────────────────── */

interface Contact {
  id: number;
  email: string | null;
  status: string;
}

interface Enrollment {
  contactId: number;
  sequenceId: number;
}

function computeNewEnrollments(
  contacts: Contact[],
  sequenceId: number,
  existingEnrollments: Enrollment[],
  requireEmail: boolean
): Enrollment[] {
  const alreadyEnrolled = new Set(
    existingEnrollments
      .filter((e) => e.sequenceId === sequenceId)
      .map((e) => e.contactId)
  );

  return contacts
    .filter((c) => !alreadyEnrolled.has(c.id))
    .filter((c) => !requireEmail || (c.email && c.email.trim() !== ""))
    .map((c) => ({ contactId: c.id, sequenceId }));
}

describe("segment rule enrollment", () => {
  const contacts: Contact[] = [
    { id: 1, email: "a@x.com", status: "active" },
    { id: 2, email: "b@x.com", status: "active" },
    { id: 3, email: null, status: "active" },
    { id: 4, email: "d@x.com", status: "active" },
  ];

  it("enrolls contacts not already in the sequence", () => {
    const existing: Enrollment[] = [{ contactId: 1, sequenceId: 10 }];
    const result = computeNewEnrollments(contacts, 10, existing, false);
    expect(result.map((e) => e.contactId)).not.toContain(1);
    expect(result.map((e) => e.contactId)).toContain(2);
  });

  it("skips contacts with no email when requireEmail=true", () => {
    const result = computeNewEnrollments(contacts, 10, [], true);
    expect(result.find((e) => e.contactId === 3)).toBeUndefined();
  });

  it("includes contacts with no email when requireEmail=false", () => {
    const result = computeNewEnrollments(contacts, 10, [], false);
    expect(result.find((e) => e.contactId === 3)).toBeDefined();
  });

  it("does not double-enroll contacts already in a different sequence", () => {
    const existing: Enrollment[] = [{ contactId: 1, sequenceId: 99 }]; // different sequence
    const result = computeNewEnrollments(contacts, 10, existing, false);
    expect(result.find((e) => e.contactId === 1)).toBeDefined(); // should enroll in seq 10
  });

  it("returns empty array when all contacts already enrolled", () => {
    const existing: Enrollment[] = contacts.map((c) => ({ contactId: c.id, sequenceId: 10 }));
    const result = computeNewEnrollments(contacts, 10, existing, false);
    expect(result).toHaveLength(0);
  });

  it("assigns correct sequenceId to all new enrollments", () => {
    const result = computeNewEnrollments(contacts, 42, [], false);
    expect(result.every((e) => e.sequenceId === 42)).toBe(true);
  });
});
