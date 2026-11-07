/**
 * Research does not invent people (audit 2026-10-20, P73). The News and
 * Google Business prompts no longer ask for a decision-maker the page may not
 * name, and a name (or an email) the model returns that is not in the text it
 * read is taken off the find, which stays as the company it is about.
 *
 * The page fetch and the model are stubbed: nothing leaves the process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ page: "", answer: [] as Array<Record<string, unknown>>, prompts: [] as string[] }));
vi.mock("./services/scraper/ssrfGuard", async (a) => ({
  ...(await a<typeof import("./services/scraper/ssrfGuard")>()),
  safeFetch: async () => new Response(h.page, { status: 200 }),
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (p: any) => {
    h.prompts.push(p.messages.map((m: any) => m.content).join("\n"));
    return { choices: [{ message: { content: JSON.stringify({ prospects: h.answer, summary: "" }) } }] };
  },
}));

import { dropUnsourcedPeople, scrapeGoogleBusiness, scrapeNews } from "./routers/are/scraper";

const blank = { firstName: "", lastName: "", title: "", email: "", phone: "", linkedinUrl: "", companyName: "", companyDomain: "", companySize: "", industry: "", geography: "", sourceUrl: "", triggerEvent: "", confidence: 50 };
const found = (over: Record<string, unknown>) => ({ ...blank, ...over });

beforeEach(() => {
  h.prompts = [];
  h.page = "";
  h.answer = [];
});

describe("a name the source does not contain is dropped (P73)", () => {
  it("news: a named person stays, an invented decision-maker becomes the company only", async () => {
    h.page = "<rss><item><title>Acme Foundation names Dana Reyes executive director</title><description>Acme Foundation raised $4m. Contact press@acme.example.</description></item><item><title>Beta Trust opens new office</title></item></rss>";
    h.answer = [
      found({ firstName: "Dana", lastName: "Reyes", title: "Executive Director", companyName: "Acme Foundation", email: "press@acme.example" }),
      found({ firstName: "John", lastName: "Smith", title: "CEO", companyName: "Beta Trust", email: "john.smith@beta.example" }),
    ];
    const out = await scrapeNews(2, null, "foundation director", "Titles: Director");
    expect(out[0]).toMatchObject({ firstName: "Dana", lastName: "Reyes", title: "Executive Director", email: "press@acme.example" });
    expect(out[1]).toMatchObject({ firstName: "", lastName: "", title: "", email: "", companyName: "Beta Trust" });
    expect(h.prompts[0]).not.toContain("the most relevant decision-maker to contact");
    expect(h.prompts[0]).toContain("never supply a name the content does not contain");
  });

  it("Google Business: no owner or manager is made up for a listing that names nobody", async () => {
    h.page = "<html><div>Riverside Dental · 4.8 stars · Richmond, VA · Owner: María López</div><div>Hilltop Bakery · Richmond</div></html>";
    h.answer = [
      found({ firstName: "Maria", lastName: "Lopez", title: "Owner", companyName: "Riverside Dental" }),
      found({ firstName: "Owner", lastName: "Manager", title: "Owner", companyName: "Hilltop Bakery" }),
    ];
    const out = await scrapeGoogleBusiness(2, null, "dentist richmond", "", 1);
    // Accents and case do not matter.
    expect(out[0]).toMatchObject({ firstName: "Maria", lastName: "Lopez" });
    expect(out[1]).toMatchObject({ firstName: "", lastName: "", title: "", companyName: "Hilltop Bakery" });
    expect(h.prompts[0]).not.toContain("use the business owner/manager as the contact");
    expect(h.prompts[0]).toContain("Never invent a person");
  });

  it("needs every part of the name, as words", () => {
    const text = "Jo Ann Smithers spoke. O'Brien-Lee also attended.";
    const names = dropUnsourcedPeople([
      found({ firstName: "Jo Ann", lastName: "Smithers" }),
      found({ firstName: "Jo", lastName: "Smith" }),
      found({ firstName: "Pat", lastName: "O'Brien-Lee" }),
      found({ firstName: "", lastName: "", companyName: "Gamma" }),
    ], text).map((p) => `${p.firstName} ${p.lastName}`.trim());
    expect(names).toEqual(["Jo Ann Smithers", "", "", ""]);
  });
});
