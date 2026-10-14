/**
 * Finds every invokeLLM / streamLLM call in the server, for coverage tests.
 *
 * Each site is keyed `<file>::<enclosing name>` (with `#2`, `#3`… when one
 * function makes several calls), where the enclosing name is the nearest tRPC
 * procedure, function, or route above the call. The arguments are the
 * balanced text of the call, so a test can ask what a site passes.
 *
 * Test-only: nothing in the app imports it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type LlmCallSite = { key: string; file: string; line: number; name: string; args: string };

const ROOT = join(__dirname, "..", "..");

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "__fakes__" || entry === "node_modules") continue;
        walk(p);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(join(ROOT, "server"));
  return out;
}

/** Strips comments but keeps every character's position, so indexes still line up. */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const NAME_PATTERNS = [
  /(\w+):\s*(?:workspaceProcedure|repProcedure|managerProcedure|adminWsProcedure|protectedProcedure|publicProcedure|superAdminProcedure|adminProcedure)\b/g,
  /(?:async\s+)?function\*?\s+(\w+)/g,
  /(?:const|let)\s+(\w+)\s*=\s*async\b/g,
  /\b(?:app|router)\.(?:post|get|put)\(\s*["'`]([^"'`]+)["'`]/g,
  /case\s+"([\w-]+)":/g,
];

function enclosingName(src: string, index: number): string {
  let best = { at: -1, name: "(top level)" };
  for (const re of NAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) && m.index < index) {
      if (m.index > best.at) best = { at: m.index, name: m[1] };
    }
  }
  return best.name;
}

function balancedArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

export function findLlmCallSites(): LlmCallSite[] {
  const sites: LlmCallSite[] = [];
  for (const abs of serverFiles()) {
    const file = relative(ROOT, abs).split(sep).join("/");
    if (file === "server/_core/llm.ts" || file === "server/_core/llmStream.ts") continue;
    const raw = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    const src = blankComments(raw);
    const re = /\b(invokeLLM|streamLLM)\s*\(/g;
    let m: RegExpExecArray | null;
    const seen = new Map<string, number>();
    while ((m = re.exec(src))) {
      // A definition or a type position, not a call.
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/function\*?\s*$/.test(before) || /typeof\s*$/.test(before)) continue;
      const name = enclosingName(src, m.index);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const line = src.slice(0, m.index).split("\n").length;
      const args = balancedArgs(src, m.index + m[0].length - 1);
      sites.push({ key: `${file}::${name}${n > 1 ? `#${n}` : ""}`, file, line, name, args });
    }
  }
  return sites;
}
