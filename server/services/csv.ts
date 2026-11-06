/**
 * CSV parser — RFC 4180 quoting, CRLF, and comma / semicolon / tab files.
 * Returns headers + array of {column → value} row maps.
 *
 * Originally lived in server/routers/imports.ts; extracted so the prospect
 * importer (and any future CSV-consuming code) can share it.
 *
 * It used to split the text on newlines BEFORE reading quotes (audit
 * 2026-10-20, R53). A quoted cell holding a line break — an Outlook or Google
 * Contacts address, a Notes column — became two rows: the head lost every
 * column after the break and the tail was a "row" with no name. Outlook puts
 * the business address before "E-mail Address" and Google puts it before
 * "Organization 1 - Name", so on those exports (which the import page names
 * as sources) every contact with an address failed as "Missing Email" or
 * "Missing Company". Records are now read character by character, and a
 * line break ends a record only outside quotes.
 *
 * Quotes are special only where a field starts with one (leading spaces
 * allowed), as RFC 4180 has it, so a stray inch mark in `5'11"` stays text
 * instead of swallowing the rows after it. A quote that is never closed falls
 * back to reading the rest of the file one line per record, which is what the
 * old parser did with every line.
 */

export type CsvDelimiter = "," | ";" | "\t";

const DELIMITERS: CsvDelimiter[] = [",", ";", "\t"];

/**
 * The delimiter the header line uses: whichever of comma, semicolon and tab
 * appears most often outside quotes in it, comma on a tie. Excel writes
 * semicolons in locales whose decimal mark is a comma, and "Unicode text"
 * exports are tab-separated; read as commas, either one arrived as a single
 * column that nothing could be mapped to.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let fieldStart = true;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Blank leading lines are skipped by the parser too.
      if (sawContent) break;
      fieldStart = true;
      continue;
    }
    if (ch === '"' && fieldStart) { inQuotes = true; sawContent = true; fieldStart = false; continue; }
    if (counts.has(ch as CsvDelimiter)) {
      counts.set(ch as CsvDelimiter, counts.get(ch as CsvDelimiter)! + 1);
      sawContent = true;
      fieldStart = true;
      continue;
    }
    if (ch !== " ") { fieldStart = false; sawContent = true; }
  }
  let best: CsvDelimiter = ",";
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Split text into records of raw (untrimmed) fields. `spanLines` false makes a
 * line break end a record even inside quotes — the fallback for a quote that
 * is never closed. Returns the records and, when the text ended inside an
 * open quote, the offset of the record that opened it.
 */
function readRecords(
  text: string,
  delim: CsvDelimiter,
  spanLines: boolean,
): { records: string[][]; unclosedAt: number | null } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  let recordStart = 0;
  let recordHasContent = false;

  const endField = () => { record.push(field); field = ""; fieldStart = true; };
  const endRecord = (next: number) => {
    endField();
    // A blank line is not a record (the old parser filtered them out too).
    if (recordHasContent) records.push(record);
    record = [];
    recordHasContent = false;
    recordStart = next;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else if (!spanLines && (ch === "\n" || ch === "\r")) {
        inQuotes = false;
        endRecord(ch === "\r" && text[i + 1] === "\n" ? ++i + 1 : i + 1);
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      // Leading spaces before the opening quote are padding, not content.
      field = "";
      inQuotes = true;
      fieldStart = false;
      recordHasContent = true;
      continue;
    }
    if (ch === delim) { endField(); recordHasContent = true; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { endRecord(i + 2); i++; continue; }
    if (ch === "\n") { endRecord(i + 1); continue; }
    field += ch;
    if (ch !== " " && ch !== "\t") { fieldStart = false; recordHasContent = true; }
  }
  if (inQuotes && spanLines) return { records, unclosedAt: recordStart };
  endRecord(text.length);
  return { records, unclosedAt: null };
}

export function parseCSVText(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  // A UTF-8 BOM would sit in front of an opening quote and stop it reading as
  // one; uniqueHeaders still strips it from an unquoted first header.
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
  const delim = detectDelimiter(csvText);
  let { records, unclosedAt } = readRecords(csvText, delim, true);
  if (unclosedAt !== null) {
    // An unterminated quote: everything from its record on is read line by
    // line, so one bad cell costs its own row and not the rest of the file.
    records = records.concat(readRecords(csvText.slice(unclosedAt), delim, false).records);
  }
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = uniqueHeaders(records[0].map((h) => h.trim()));
  const rows = records.slice(1).map((values) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}

/**
 * Make every header a distinct, usable key.
 *
 * A row is a `{header → value}` map, so two columns sharing a header collapsed
 * into one and the LAST one silently won — the first column's data vanished with
 * no error, and the mapping UI only ever showed one of them. Exports with a
 * repeated "Email" or a trailing empty column (a line ending in a comma) are
 * ordinary, so this is not a hypothetical file.
 *
 * Blank headers become "Column N" rather than sharing the "" key, and a repeat
 * gets " (2)", " (3)"… — visible in the mapping step, which is the point: the
 * user can map both columns, or map one and ignore the other.
 */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    // A UTF-8 BOM lands on the FIRST header, so Excel's "Email" arrives with it
    // still attached. Mapping still worked end-to-end (both sides used the same
    // string) but auto-detection could never match the first column, so column 1
    // — usually First Name — silently arrived unmapped.
    // Compared by code point rather than a regex literal: a bare BOM in source
    // is invisible and one editor pass can silently drop it.
    const noBom = h.charCodeAt(0) === 0xfeff ? h.slice(1) : h;
    const base = noBom.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}
