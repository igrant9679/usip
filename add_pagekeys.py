import re, os

PAGE_DIR = "/home/ubuntu/usip/client/src/pages/usip"

# All pages with their pageKey values
ALL_KEYS = {
    "ARECampaignDetail": "are-campaign-detail",
    "ARECampaigns": "are-campaigns",
    "AREHub": "are-hub",
    "AREIcpAgent": "are-icp-agent",
    "ARESettings": "are-settings",
    "BrandVoice": "brand-voice",
    "ConnectedAccounts": "connected-accounts",
    "DataHealth": "data-health",
    "EmailAnalytics": "email-analytics",
    "EmailBuilder": "email-builder",
    "ImportContacts": "import-contacts",
    "MyLinkedIn": "my-linkedin",
    "PipelineAlerts": "pipeline-alerts",
    "PromptTemplates": "prompt-templates",
    "Segments": "segments",
    "SenderPools": "sender-pools",
    "SendingAccounts": "sending-accounts",
    "Snippets": "snippets",
    "UnifiedInbox": "unified-inbox",
    "Audit": "audit",
    "Inbox": "inbox",
    "NotificationPrefs": "notification-prefs",
    "Pipeline": "pipeline",
    "SegmentRules": "segment-rules",
    "Sequences": "sequences",
    "Settings": "settings",
    "Team": "team",
    "Territories": "territories",
    "Workflows": "workflows",
    "Contacts": "contacts",
    "LeadScoring": "lead-scoring",
    "Accounts": "accounts",
    "Calendar": "calendar",
    "Campaigns": "campaigns",
    "Customers": "customers",
    "Dashboard": "dashboard",
    "DashboardHome2": "dashboard-home2",
    "Dashboards": "dashboards",
    "EmailDrafts": "email-drafts",
    "EmailSuppressions": "email-suppressions",
    "LeadRouting": "lead-routing",
    "Leads": "leads",
    "Mailbox": "mailbox",
    "Products": "products",
    "QBRs": "qbrs",
    "Quotes": "quotes",
    "Renewals": "renewals",
    "SCIM": "scim",
    "Social": "social",
    "Tasks": "tasks",
    "Workflows": "workflows",
}

for fname, key in ALL_KEYS.items():
    path = os.path.join(PAGE_DIR, f"{fname}.tsx")
    if not os.path.exists(path):
        continue
    content = open(path).read()
    
    def add_key(m):
        s = m.group(0)
        if 'pageKey=' in s:
            return s
        # Insert pageKey after title={...} or title="..."
        # Try dynamic title first: title={...}
        new_s = re.sub(r'(title=\{[^}]*\})', rf'\1\n        pageKey="{key}"', s, count=1)
        if new_s != s:
            return new_s
        # Try static title: title="..."
        new_s = re.sub(r'(title="[^"]*")', rf'\1 pageKey="{key}"', s, count=1)
        return new_s
    
    new = re.sub(r'<PageHeader[^>]*>', add_key, content, flags=re.DOTALL)
    if new != content:
        open(path, 'w').write(new)
        print(f"Updated {fname}.tsx with pageKey={key}")
    else:
        print(f"No change: {fname}.tsx")

print("Done.")
