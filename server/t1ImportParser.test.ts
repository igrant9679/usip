/**
 * Audit 2026-10-20, R53: "CSV importers: quoted line breaks split rows; no
 * delimiter or encoding detection." services/csv.ts split the text on newlines
 * before it read quotes, read only commas, and the page decoded every file as
 * UTF-8. Both importers (contacts and the LeadRocks prospect importer) share
 * this parser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { detectDelimiter, parseCSVText } from "./services/csv";
import { decodeCsvBytes, isImportableFileName } from "@shared/importFields";

describe("quoted line breaks stay inside their row", () => {
  it("a multi-line address is one cell, and the columns after it stay on the row", () => {
    const csv =
      'First Name,Last Name,Business Street,E-mail Address,Company\r\n' +
      'Ada,Lovelace,"12 Analytical Way\r\nSuite 4\r\nLondon",ada@example.com,Engines Ltd\r\n' +
      'Alan,Turing,"1 Bletchley\nPark",alan@example.com,Bombe Co\r\n';
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name", "Business Street", "E-mail Address", "Company"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]["Business Street"]).toBe("12 Analytical Way\r\nSuite 4\r\nLondon");
    expect(rows[0]["E-mail Address"]).toBe("ada@example.com");
    expect(rows[0].Company).toBe("Engines Ltd");
    expect(rows[1]["E-mail Address"]).toBe("alan@example.com");
  });

  it("a line break in a quoted header is part of the header", () => {
    const { headers, rows } = parseCSVText('"Full\nName",Email\nAda,ada@example.com');
    expect(headers).toEqual(["Full\nName", "Email"]);
    expect(rows).toEqual([{ "Full\nName": "Ada", Email: "ada@example.com" }]);
  });

  it("a quote that never closes costs its own row, not the rest of the file", () => {
    const csv = 'Name,Height\nAda,"5ft\nAlan,6ft\nGrace,5ft\n';
    const { rows } = parseCSVText(csv);
    expect(rows.map((r) => r.Name)).toEqual(["Ada", "Alan", "Grace"]);
    expect(rows[2].Height).toBe("5ft");
  });

  it("a quote inside an unquoted cell is text, and does not swallow the rows after it", () => {
    const csv = 'Name,Height,Note\nAda,5\'11",x\nAlan,"6ft",y\nGrace,5ft,z\n';
    const { rows } = parseCSVText(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ Name: "Ada", Height: '5\'11"', Note: "x" });
    expect(rows[1].Height).toBe("6ft");
  });
});

describe("delimiters", () => {
  it("reads a semicolon file (Excel in comma-decimal locales)", () => {
    const csv = "First Name;Last Name;Email;Company\nJosé;García;jose@example.es;\"Acme; Iberia\"\n";
    expect(detectDelimiter(csv)).toBe(";");
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name", "Email", "Company"]);
    expect(rows[0]).toEqual({ "First Name": "José", "Last Name": "García", Email: "jose@example.es", Company: "Acme; Iberia" });
  });

  it("reads a tab-separated file", () => {
    const csv = "First Name\tLast Name\tCompany\nAda\tLovelace\tEngines, Ltd\n";
    expect(detectDelimiter(csv)).toBe("\t");
    expect(parseCSVText(csv).rows[0]).toEqual({ "First Name": "Ada", "Last Name": "Lovelace", Company: "Engines, Ltd" });
  });

  it("stays on commas when the header has a semicolon inside a quoted name, or on a tie", () => {
    expect(detectDelimiter('"Notes; misc",Email\nx,y')).toBe(",");
    expect(detectDelimiter("A;B,C\n1;2,3")).toBe(",");
    expect(detectDelimiter("\n\nA;B\n1;2")).toBe(";");
  });
});

describe("what the old parser already did, unchanged", () => {
  it("empty and blank files, header-only files, blank lines", () => {
    expect(parseCSVText("")).toEqual({ headers: [], rows: [] });
    expect(parseCSVText("\n\n")).toEqual({ headers: [], rows: [] });
    expect(parseCSVText("Name,Email\n")).toEqual({ headers: ["Name", "Email"], rows: [] });
    expect(parseCSVText("Name,Email\n\n  \nAda,a@x.com\n\n").rows).toEqual([{ Name: "Ada", Email: "a@x.com" }]);
  });

  it("escaped quotes, quoted commas, trimmed values, short rows padded", () => {
    const { rows } = parseCSVText('Name,Note,Extra\n "Smith, John" , "He said ""hi""" \nAda\n');
    expect(rows[0]).toEqual({ Name: "Smith, John", Note: 'He said "hi"', Extra: "" });
    expect(rows[1]).toEqual({ Name: "Ada", Note: "", Extra: "" });
  });

  it("a UTF-8 BOM in front of a quoted first header", () => {
    const { headers, rows } = parseCSVText('﻿"First Name","Last Name"\nAda,Lovelace');
    expect(headers).toEqual(["First Name", "Last Name"]);
    expect(rows[0]["First Name"]).toBe("Ada");
  });

  it("the LeadRocks prospect importer still reads its file through the same parser", () => {
    const src = readFileSync("server/routers/prospectImports.ts", "utf8");
    expect(src).toContain('import { parseCSVText } from "../services/csv";');
    const { headers, rows } = parseCSVText(
      'First Name,Last Name,Linked Url,Company Website,Work Email #1\n"Ada","Lovelace","https://linkedin.com/in/ada","engines.co","ada@engines.co"\n',
    );
    expect(headers).toContain("Work Email #1");
    expect(rows[0]["Linked Url"]).toBe("https://linkedin.com/in/ada");
  });
});

describe("encodings (the page decodes the bytes itself)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("UTF-16 with a byte-order mark, little and big endian", () => {
    const text = "First Name\tLast Name\nJosé\tMüller\n";
    const le = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff; le[1] = 0xfe;
    const be = new Uint8Array(2 + text.length * 2);
    be[0] = 0xfe; be[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8;
      be[2 + i * 2] = c >> 8; be[3 + i * 2] = c & 0xff;
    }
    expect(decodeCsvBytes(le)).toBe(text);
    expect(decodeCsvBytes(be)).toBe(text);
    expect(parseCSVText(decodeCsvBytes(le)).rows[0]).toEqual({ "First Name": "José", "Last Name": "Müller" });
  });

  it("Windows-1252 bytes when they are not valid UTF-8; UTF-8 left alone", () => {
    // "José,Müller" in Windows-1252: é = 0xE9, ü = 0xFC.
    const cp1252 = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]);
    expect(decodeCsvBytes(cp1252)).toBe("José,Müller");
    expect(decodeCsvBytes(enc("José,Müller"))).toBe("José,Müller");
    // A UTF-8 BOM is dropped by the decoder.
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Name")]))).toBe("Name");
  });

  it("the page reads bytes and decodes them, and takes .csv in any case plus .tsv/.txt", () => {
    const page = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");
    expect(page).toContain("reader.readAsArrayBuffer(f)");
    expect(page).toContain("decodeCsvBytes(new Uint8Array(");
    expect(page).not.toContain("reader.readAsText(f)");
    expect(page).toContain("if (!isImportableFileName(f.name))");
    expect(isImportableFileName("CONTACTS.CSV")).toBe(true);
    expect(isImportableFileName("export.tsv")).toBe(true);
    expect(isImportableFileName("export.txt")).toBe(true);
    expect(isImportableFileName("export.xlsx")).toBe(false);
  });
});
