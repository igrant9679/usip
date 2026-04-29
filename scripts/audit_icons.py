"""
Audit all page files to find PageHeader icons that are not imported from lucide-react.
"""
import os
import re

pages_dir = "/home/ubuntu/usip/client/src/pages/usip"
issues = []

for fname in sorted(os.listdir(pages_dir)):
    if not fname.endswith(".tsx"):
        continue
    path = os.path.join(pages_dir, fname)
    content = open(path).read()

    # Find all icon names used in PageHeader icon prop
    icon_uses = re.findall(r'icon=\{<(\w+)\s', content)
    if not icon_uses:
        continue

    # Extract all names imported from lucide-react
    # Handle both single-line and multi-line imports
    lucide_imported = set()
    for m in re.finditer(r'from\s+"lucide-react"\s*;', content):
        # Walk backwards to find the opening brace
        end = m.start()
        start = content.rfind("import", 0, end)
        if start != -1:
            block = content[start:m.end()]
            names = re.findall(r'\b([A-Z][a-zA-Z0-9]+)\b', block)
            lucide_imported.update(names)

    for icon in icon_uses:
        if icon not in lucide_imported:
            issues.append(f"{fname}: <{icon}> NOT imported from lucide-react (lucide imports: {sorted(lucide_imported)[:5]}...)")

if issues:
    print(f"Found {len(issues)} issues:")
    for i in issues:
        print(" ", i)
else:
    print("All PageHeader icons are correctly imported.")
