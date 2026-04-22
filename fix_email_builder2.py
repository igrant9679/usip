"""
More robust fix: find all 'async ({ ctx' or 'async ({' callbacks that contain 'await db'
and inject 'const db = await getDb();' at the top of each one.

Strategy: parse line by line, track when we enter an async callback, 
and inject the db getter right after the opening brace if the callback uses db.
"""
import re

with open("server/routers/emailBuilder.ts", "r") as f:
    content = f.read()

# Find all occurrences of 'async (' that start a callback (query/mutation/etc.)
# and inject db getter if not already present.
# We'll do a regex substitution on the pattern:
# async ({ ... }) => {\n      (no db getter yet)
# -> async ({ ... }) => {\n      const db = await getDb();\n      if (!db) throw...

# Pattern: async callback opening that does NOT already have getDb on the next line
# We'll use a state machine approach

lines = content.split("\n")
result = []
i = 0

while i < len(lines):
    line = lines[i]
    result.append(line)
    
    # Detect: line ends with ') => {' or contains ') => {' after async (
    # This is the opening of an async callback body
    if re.search(r'async\s*\([^)]*\)\s*=>\s*\{', line):
        # Check if next line already has getDb
        if i + 1 < len(lines) and "getDb()" in lines[i + 1]:
            i += 1
            continue
        
        # Determine the indentation of the next non-empty line
        indent = "      "
        for j in range(i + 1, min(i + 5, len(lines))):
            if lines[j].strip():
                indent = " " * (len(lines[j]) - len(lines[j].lstrip()))
                break
        
        # Look ahead to see if this callback uses 'db' (without getDb already)
        # Scan forward to find the matching closing brace
        depth = 1
        uses_db = False
        for j in range(i + 1, len(lines)):
            l = lines[j]
            depth += l.count("{") - l.count("}")
            if re.search(r'\bdb\b', l) and "getDb" not in l:
                uses_db = True
            if depth <= 0:
                break
        
        if uses_db:
            result.append(f"{indent}const db = await getDb();")
            result.append(f'{indent}if (!db) throw new TRPCError({{ code: "INTERNAL_SERVER_ERROR" }});')
    
    i += 1

new_content = "\n".join(result)
with open("server/routers/emailBuilder.ts", "w") as f:
    f.write(new_content)

# Count remaining bare 'db.' (not preceded by 'await getDb' on same line)
remaining = len(re.findall(r'(?<!getDb\(\);)\n\s+(?:const \[|await )db\.', new_content))
print(f"Done. Lines: {len(result)}")
