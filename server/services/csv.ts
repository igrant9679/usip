/**
 * CSV parser — handles quoted fields, escaped quotes, and CRLF.
 * Returns headers + array of {column → value} row maps.
 *
 * Originally lived in server/routers/imports.ts; extracted so the prospect
 * importer (and any future CSV-consuming code) can share it.
 *
 * NOT a full RFC-4180 parser — doesn't handle embedded newlines in quoted
 * fields. Adequate for LeadRocks / Hunter / Apollo exports; if we ever
 * encounter multi-line cells, swap in papaparse here and callers don't
 * need to change.
 */
export function parseCSVText(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const headers = uniqueHeaders(parseLine(lines[0]));
  const rows = lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
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
