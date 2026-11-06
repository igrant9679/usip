/**
 * The LinkedIn enrichment import reads the files people have (audit
 * 2026-10-20, P91), and is a page people can find and come back to (P96).
 *
 *   P91  quoted line breaks, doubled quotes, CRLF, a byte-order mark and a
 *        semicolon or tab delimiter · the header found below a preamble (a
 *        LinkedIn connections export opens with "Notes:") · columns guessed
 *        from the names exports really use, then chosen by the person ·
 *        http:// profile links accepted · files over a batch's 1,000 rows
 *        imported a slice at a time.
 *   P96  reachable from Data enrichment and the tool library, the batch kept
 *        in the URL across a reload, and controls a rep can't use say why.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_BATCH_ROWS, columnNames, findHeaderRow, guessMapping, parseCsvRecords, rowsFromMapping,
} from "../client/src/lib/linkedinCsv";
import { validateLinkedInUrl } from "./services/linkedinEnrichment/mapper";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("parseCsvRecords", () => {
  it("keeps a quoted line break, comma and doubled quote inside one cell", () => {
    const recs = parseCsvRecords('url,note\r\nhttps://linkedin.com/in/a,"line one\nline two, with ""quotes"""\r\n');
    expect(recs).toEqual([["url", "note"], ["https://linkedin.com/in/a", 'line one\nline two, with "quotes"']]);
  });

  it("drops a byte-order mark and blank lines", () => {
    expect(parseCsvRecords("﻿url\n\n\nhttps://linkedin.com/in/a\n")).toEqual([["url"], ["https://linkedin.com/in/a"]]);
  });

  it.each([[";"], ["\t"]])("reads a %j-delimited file", (d) => {
    expect(parseCsvRecords(`url${d}name\nhttps://linkedin.com/in/a${d}Ann`)).toEqual([["url", "name"], ["https://linkedin.com/in/a", "Ann"]]);
  });
});

describe("the header and the mapping", () => {
  // The shape of LinkedIn's own connections export.
  const connections = [
    "Notes:",
    '"When exporting your connection data, you may notice that some of the email addresses are missing.\nYou will only see email addresses for connections who have allowed it."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Ann,Lee,http://www.linkedin.com/in/ann-lee,,Acme,VP Sales,01 Nov 2026",
    "Bo,Ng,https://www.linkedin.com/in/bo-ng,bo@initech.example,Initech,CFO,02 Nov 2026",
  ].join("\n");

  it("finds the header below a preamble, and maps the columns exports really use", () => {
    const recs = parseCsvRecords(connections);
    const header = findHeaderRow(recs);
    expect(header).toBe(2);
    const map = guessMapping(recs, header);
    expect(map).toMatchObject({ firstName: 0, lastName: 1, linkedinUrl: 2, email: 3, company: 4, title: 5 });
    const rows = rowsFromMapping(recs, header, map);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ linkedinUrl: "http://www.linkedin.com/in/ann-lee", firstName: "Ann", company: "Acme", title: "VP Sales" });
    expect(rows[1].email).toBe("bo@initech.example");
  });

  it("an Apollo-style header is recognised too", () => {
    const recs = parseCsvRecords("Name,Title,Company Name,Person Linkedin Url\nAnn Lee,VP,Acme,https://linkedin.com/in/ann");
    expect(guessMapping(recs, findHeaderRow(recs))).toMatchObject({ fullName: 0, title: 1, company: 2, linkedinUrl: 3 });
  });

  it("a headerless list maps the column that holds the URLs", () => {
    const recs = parseCsvRecords("Ann Lee,https://linkedin.com/in/ann\nBo Ng,https://linkedin.com/in/bo");
    const header = findHeaderRow(recs);
    expect(header).toBeNull();
    expect(guessMapping(recs, header).linkedinUrl).toBe(1);
    expect(rowsFromMapping(recs, header, guessMapping(recs, header))).toHaveLength(2);
    expect(columnNames(recs, header)).toEqual(["Column 1", "Column 2"]);
  });

  it("the person's mapping wins over the guess", () => {
    const recs = parseCsvRecords("profile,backup\nhttps://linkedin.com/in/a,https://linkedin.com/in/b");
    expect(rowsFromMapping(recs, 0, { linkedinUrl: 1 })[0].linkedinUrl).toBe("https://linkedin.com/in/b");
    expect(rowsFromMapping(recs, 0, {})).toEqual([]);
  });

  it("a prospect id is a number or nothing", () => {
    const recs = parseCsvRecords("url,prospect_id\nhttps://linkedin.com/in/a,42\nhttps://linkedin.com/in/b,x");
    expect(rowsFromMapping(recs, 0, guessMapping(recs, 0)).map((r) => r.prospectId)).toEqual([42, undefined]);
  });
});

describe("validation and the batch size", () => {
  it("an http:// profile link is accepted, stored as https", () => {
    expect(validateLinkedInUrl("http://www.linkedin.com/in/ann-lee")).toMatchObject({ valid: true, normalizedUrl: "https://www.linkedin.com/in/ann-lee" });
  });

  it("a batch is the size createBatch takes, and the page slices a longer file into batches", () => {
    expect(MAX_BATCH_ROWS).toBe(1000);
    expect(read("server/routers/linkedinEnrichment.ts")).toContain("rows: z.array(rowInput).min(1).max(1000),");
    const page = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");
    expect(page).toContain("const rows = allRows.slice(chunk * MAX_BATCH_ROWS, (chunk + 1) * MAX_BATCH_ROWS);");
    expect(page).toContain("createMut.mutate({ sourceType: file ? \"csv_upload\" : \"pasted_urls\", rows })");
  });
});

describe("the page (P91 mapping, P96)", () => {
  const page = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");

  it("reads files with the one reader and offers the mapping", () => {
    expect(page).not.toContain("text.split(/\\r?\\n/)");
    expect(page).toContain("const records = parseCsvRecords(String(reader.result ?? \"\"));");
    expect(page).toContain("{LINKEDIN_IMPORT_FIELDS.map((f) => (");
    expect(page).toContain("onChange={(e) => setMapping(f.key,");
  });

  it("keeps the batch in the URL, so a reload comes back to it", () => {
    expect(page).toContain("useState<number | null>(batchFromUrl)");
    expect(page).toContain("const setBatchId = (id: number | null) => { setBatchIdState(id); writeBatchToUrl(id); };");
  });

  it("tells a rep why import and run are not theirs", () => {
    expect(page).toContain("disabled={createMut.isPending || !isManager}");
    expect(page).toContain("A manager imports and runs these batches.");
    expect(page).toContain("A manager runs enrichment.");
  });

  it("is reachable from Data enrichment and from the tool library", () => {
    expect(read("client/src/pages/usip/DataEnrichment.tsx")).toContain('setLocation("/v2/data-enrichment/linkedin")}><Upload className="size-4 mr-2" /> Import LinkedIn URLs');
    expect(read("client/src/lib/toolRegistry.ts")).toContain('{ href: "/v2/data-enrichment/linkedin", label: "LinkedIn Enrichment Import"');
  });
});
