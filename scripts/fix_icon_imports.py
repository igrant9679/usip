"""
Add missing lucide-react icon imports to all page files that use icons in PageHeader.
"""
import os, re

pages_dir = "/home/ubuntu/usip/client/src/pages/usip"

# Map of file -> icon name to import
# Derived from the audit output
file_icons = {
    "AIPipelineQueue.tsx": "Sparkles",
    "ARECampaignDetail.tsx": "Megaphone",
    "ARECampaigns.tsx": "Megaphone",
    "AREHub.tsx": "Rocket",
    "AREIcpAgent.tsx": "Target",
    "ARESettings.tsx": "Settings2",
    "Accounts.tsx": "Building2",
    "Audit.tsx": "ClipboardList",
    "BrandVoice.tsx": "Mic2",
    "Calendar.tsx": "CalendarDays",
    "Campaigns.tsx": "Layers3",
    "ConnectedAccounts.tsx": "Link2",
    "Contacts.tsx": "Users",
    "CustomFields.tsx": "SlidersHorizontal",
    "Customers.tsx": "HeartHandshake",
    "Dashboard.tsx": "LayoutDashboard",
    "DashboardHome2.tsx": "LayoutDashboard",
    "Dashboards.tsx": "LayoutGrid",
    "DataHealth.tsx": "ShieldCheck",
    "EmailAnalytics.tsx": "BarChart2",
    "EmailBuilder.tsx": "PenLine",
    "EmailDrafts.tsx": "FileText",
    "EmailSuppressions.tsx": "Ban",
    "ImportContacts.tsx": "Upload",
    "Inbox.tsx": "Bell",
    "LeadRouting.tsx": "GitMerge",
    "LeadScoring.tsx": "Gauge",
    "Leads.tsx": "UserPlus",
    "Mailbox.tsx": "Mail",
    "MyLinkedIn.tsx": "Linkedin",
    "NotificationPrefs.tsx": "BellRing",
    "Pipeline.tsx": "KanbanSquare",
    "PipelineAlerts.tsx": "AlertTriangle",
    "Products.tsx": "Package",
    "PromptTemplates.tsx": "MessageSquare",
    "Proposals.tsx": "ClipboardList",
    "QBRs.tsx": "Presentation",
    "Quota.tsx": "TrendingUp",
    "Quotes.tsx": "Receipt",
    "Renewals.tsx": None,  # Already fixed
    "ResearchPipeline.tsx": "FlaskConical",
    "SCIM.tsx": "Shield",
    "SegmentRules.tsx": "SlidersHorizontal",
    "Segments.tsx": "Filter",
    "SenderPools.tsx": "Layers",
    "SendingAccounts.tsx": "AtSign",
    "Sequences.tsx": "ListOrdered",
    "Settings.tsx": "Settings",  # SettingsIcon -> Settings in lucide
    "Snippets.tsx": "Scissors",
    "Social.tsx": "Share2",
    "Tasks.tsx": "CheckSquare",
    "Team.tsx": "UsersRound",
    "Territories.tsx": "Map",
    "UnifiedInbox.tsx": "Inbox",
    "Workflows.tsx": "GitBranch",
}

# Icons that need special handling (wrong name used in JSX)
icon_renames = {
    "Settings.tsx": ("SettingsIcon", "Settings"),  # file uses SettingsIcon, import as Settings
}

changed = []
skipped = []

for fname, icon in file_icons.items():
    if icon is None:
        skipped.append(fname)
        continue

    path = os.path.join(pages_dir, fname)
    if not os.path.exists(path):
        print(f"NOT FOUND: {fname}")
        continue

    content = open(path).read()

    # Check if icon is already imported
    if re.search(rf'\b{icon}\b', content.split("from \"lucide-react\"")[0] if "from \"lucide-react\"" in content else ""):
        skipped.append(fname)
        continue

    # Handle rename case (e.g. SettingsIcon -> Settings)
    if fname in icon_renames:
        wrong_name, correct_name = icon_renames[fname]
        # Replace usage in JSX
        content = content.replace(f"<{wrong_name} ", f"<{correct_name} ")
        content = content.replace(f"<{wrong_name}/", f"<{correct_name}/")
        icon = correct_name

    # Check if there's already a lucide-react import line
    lucide_pattern = re.compile(r'(import\s*\{[^}]+\}\s*from\s*"lucide-react"\s*;)')
    lucide_match = lucide_pattern.search(content)

    if lucide_match:
        # Add icon to existing lucide import
        existing = lucide_match.group(0)
        # Check if icon already in the import
        if icon in existing:
            skipped.append(fname)
            continue
        # Insert icon into the import list
        new_import = existing.rstrip(";").rstrip()
        # Find the closing brace
        new_import = re.sub(r'\}(\s*from)', f', {icon}' + r'}\1', new_import)
        new_import += ";"
        content = content.replace(existing, new_import)
    else:
        # Add new lucide import after the last import line
        # Find the last import statement
        last_import_match = None
        for m in re.finditer(r'^import .+;$', content, re.MULTILINE):
            last_import_match = m
        if last_import_match:
            insert_pos = last_import_match.end()
            content = content[:insert_pos] + f'\nimport {{ {icon} }} from "lucide-react";' + content[insert_pos:]
        else:
            content = f'import {{ {icon} }} from "lucide-react";\n' + content

    open(path, "w").write(content)
    changed.append(fname)
    print(f"FIXED: {fname} -> added {icon}")

print(f"\nTotal fixed: {len(changed)}, skipped: {len(skipped)}")
