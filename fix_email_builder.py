"""
Inject `const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });`
before the first `await db` in each async arrow function body in emailBuilder.ts.
Also fix the `db\n        .` multiline pattern.
"""
import re

with open("server/routers/emailBuilder.ts", "r") as f:
    content = f.read()

# Pattern: inside .query(async ({ ctx, input }) => { or .mutation(async ({ ... }) => {
# we need to inject the db getter before the first `await db` or `db.`
# Strategy: find each async callback body and inject at the top if it uses db

# Simpler approach: replace each async callback that contains 'await db' or 'db.'
# by injecting the db getter at the start of the function body.

# We'll use a regex to find async arrow functions and inject the db line
# Pattern: async ({ ... }) => {\n      (content)
# Inject after the opening brace

def inject_db_getter(match):
    full = match.group(0)
    # Only inject if the function body uses db
    if "await db" not in full and "\n      db" not in full:
        return full
    # Find the opening brace position
    brace_pos = full.index("{", full.index("=>"))
    before = full[:brace_pos + 1]
    after = full[brace_pos + 1:]
    # Check if db getter already injected
    if "const db = await getDb()" in after:
        return full
    # Determine indentation from first non-empty line after brace
    lines = after.split("\n")
    indent = "      "
    for line in lines[1:]:
        if line.strip():
            indent = " " * (len(line) - len(line.lstrip()))
            break
    injection = f'\n{indent}const db = await getDb();\n{indent}if (!db) throw new TRPCError({{ code: "INTERNAL_SERVER_ERROR" }});'
    return before + injection + after

# Match async arrow function bodies (greedy, non-nested)
# We'll do a simpler line-by-line approach instead
lines = content.split("\n")
result_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    # Detect start of async callback: .query(async or .mutation(async
    if re.search(r'\.(?:query|mutation)\(async\s*\(', line):
        result_lines.append(line)
        i += 1
        # Find the opening brace of the function body
        while i < len(lines):
            result_lines.append(lines[i])
            if "{" in lines[i] and "=>" in lines[i]:
                # Inject db getter on next line
                indent = "      "
                if i + 1 < len(lines):
                    next_line = lines[i + 1]
                    if next_line.strip():
                        indent = " " * (len(next_line) - len(next_line.lstrip()))
                # Check if the next few lines already have getDb
                lookahead = "\n".join(lines[i:min(i+5, len(lines))])
                if "await db" in "\n".join(lines[i:min(i+50, len(lines))]) and "const db = await getDb()" not in lookahead:
                    result_lines.append(f"{indent}const db = await getDb();")
                    result_lines.append(f'{indent}if (!db) throw new TRPCError({{ code: "INTERNAL_SERVER_ERROR" }});')
                i += 1
                break
            i += 1
    else:
        result_lines.append(line)
        i += 1

new_content = "\n".join(result_lines)

with open("server/routers/emailBuilder.ts", "w") as f:
    f.write(new_content)

print("Done. Lines:", len(result_lines))
