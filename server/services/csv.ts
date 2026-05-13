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

  const headers = parseLine(lines[0]);
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
