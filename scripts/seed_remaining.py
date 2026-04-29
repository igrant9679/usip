#!/usr/bin/env python3
"""
USIP Supplemental Seeder v3 — seeds sections not yet populated.
Uses actual DB column names verified from DESCRIBE queries.
"""

import mysql.connector
import random
import json
import time
from datetime import datetime, timedelta

DB = dict(host="shuttle.proxy.rlwy.net", port=28411, user="usip_user",
          password="usip_db_pass_2024", database="usip")

WS = 2
OWN = 2

def conn():
    return mysql.connector.connect(**DB)

def days(d):
    return datetime.now() + timedelta(days=d)

def rand(lst):
    return random.choice(lst)

def randint(a, b):
    return random.randint(a, b)

def main():
    c = conn()
    cur = c.cursor()

    # ── Get existing IDs ──────────────────────────────────────────────────────
    cur.execute("SELECT id FROM accounts WHERE workspaceId=%s", (WS,))
    account_ids = [r[0] for r in cur.fetchall()]

    cur.execute("SELECT id, stage, value, accountId FROM opportunities WHERE workspaceId=%s", (WS,))
    opp_rows = cur.fetchall()
    opp_stage_map = {r[0]: (r[1], r[2], r[3]) for r in opp_rows}

    COMPANIES = [
        "Axiom Revenue Group","Cascade Analytics","Meridian Health Systems",
        "Northline Capital","Borealis Logistics","Stonehaven Insurance",
        "Halcyon Analytics","Ironpeak Manufacturing","Kestrel Biotech","Ridgemark Partners",
    ]

    # ── Email snippets ────────────────────────────────────────────────────────
    # Correct columns: workspaceId, name, category, bodyHtml, bodyPlain, createdByUserId
    cur.execute("SELECT COUNT(*) FROM email_snippets WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding email snippets...")
        SNIPPET_CATS = ["opener","value_prop","social_proof","objection_handler","cta","closing","ps"]
        for i, snip in enumerate([
            ("Pricing objection response",
             "I completely understand — budget is always a consideration. What I'd suggest is we look at the ROI model together: most teams see payback within 90 days based on pipeline velocity improvements alone."),
            ("Meeting request — short",
             "Would you be open to a 20-minute call this week? I can work around your schedule — just reply with a couple of times that work."),
            ("Intro after referral",
             "{{referrerName}} suggested I reach out — they thought our work together might be relevant to what you're building at {{company}}. Happy to share a quick overview if it's useful."),
            ("Follow-up after no reply",
             "I know you're busy — just wanted to resurface this in case it got buried. If the timing isn't right, no worries at all. Happy to reconnect when it makes sense."),
            ("Proposal sent confirmation",
             "I've just sent over the proposal — you should have it in your inbox. Let me know if you'd like to walk through it together; I'm happy to set up a call."),
        ]):
            cur.execute("""INSERT INTO email_snippets
                           (workspaceId, name, category, bodyHtml, bodyPlain, createdByUserId, createdAt, updatedAt)
                           VALUES (%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                        (WS, snip[0], SNIPPET_CATS[i % len(SNIPPET_CATS)],
                         f"<p>{snip[1]}</p>", snip[1], OWN))
        c.commit()
        print("  Seeded 5 snippets")

    # ── Email templates ───────────────────────────────────────────────────────
    # Correct columns: workspaceId, name, description, category, subject, designData,
    #                  htmlOutput, plainOutput, status, createdByUserId
    cur.execute("SELECT COUNT(*) FROM email_templates WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding email templates...")
        for tmpl in [
            ("Cold outreach — VP RevOps",
             "Quick question about {{company}}",
             "Hi {{firstName}},\n\nI noticed {{company}} has been scaling its revenue team — congrats on the growth.\n\nWe help RevOps leaders at companies like yours consolidate pipeline, engagement, and CS data into a single platform. The result is usually a 20–30% improvement in forecast accuracy within the first quarter.\n\nWorth a 20-minute conversation?\n\nBest,\n{{senderName}}",
             "outbound"),
            ("Post-demo follow-up",
             "Next steps after our call",
             "Hi {{firstName}},\n\nGreat speaking with you today. I'll send over the proposal by end of week. In the meantime, feel free to reach out with any questions.\n\nBest,\n{{senderName}}",
             "follow_up"),
            ("Renewal reminder — 90 days out",
             "Your {{product}} renewal is coming up",
             "Hi {{firstName}},\n\nYour {{product}} subscription renews on {{renewalDate}} — just wanted to give you a heads-up with plenty of time to review.\n\nWould love to schedule a quick call to review your usage and make sure you're getting maximum value.\n\nBest,\n{{senderName}}",
             "renewal"),
            ("Churn save — executive outreach",
             "Checking in — {{company}}",
             "Hi {{firstName}},\n\nI wanted to reach out personally to make sure you're getting the most out of Velocity. Could we find 30 minutes this week?\n\nBest,\n{{senderName}}",
             "retention"),
        ]:
            plain = tmpl[2]
            html  = "<p>" + plain.replace("\n\n", "</p><p>").replace("\n", "<br>") + "</p>"
            cur.execute("""INSERT INTO email_templates
                           (workspaceId, name, category, subject, designData, htmlOutput,
                            plainOutput, status, createdByUserId, createdAt, updatedAt)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,'active',%s,NOW(),NOW())""",
                        (WS, tmpl[0], tmpl[3], tmpl[1],
                         json.dumps({"blocks": [{"type": "text", "content": plain}]}),
                         html, plain, OWN))
        c.commit()
        print("  Seeded 4 templates")

    # ── Audience segments ─────────────────────────────────────────────────────
    cur.execute("SELECT COUNT(*) FROM audience_segments WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding audience segments...")
        for seg in [
            ("Watch-tier customers",
             [{"field":"healthTier","op":"=","value":"watch"}],
             "Customers in watch or at-risk health tier"),
            ("High-score leads (B+)",
             [{"field":"score","op":">=","value":60}],
             "Leads with score >= 60"),
            ("Mid-market SaaS accounts",
             [{"field":"industry","op":"=","value":"SaaS"},{"field":"employeeBand","op":"in","value":["50-200","200-500"]}],
             "SaaS companies with 50-500 employees"),
            ("Open proposals — expiring soon",
             [{"field":"status","op":"in","value":["sent","under_review"]}],
             "Proposals currently sent or under review"),
        ]:
            cur.execute("""INSERT INTO audience_segments
                           (workspaceId, name, description, matchType, rules,
                            contactCount, createdByUserId, createdAt, updatedAt)
                           VALUES (%s,%s,%s,'all',%s,0,%s,NOW(),NOW())""",
                        (WS, seg[0], seg[2], json.dumps(seg[1]), OWN))
        c.commit()
        print("  Seeded 4 segments")

    # ── ICP profiles ──────────────────────────────────────────────────────────
    # Correct columns: workspaceId, version, targetIndustries, targetCompanySizeMin/Max,
    #                  targetTitles, targetGeographies, topConversionSignals,
    #                  avgDealValue, avgSalesCycleDays, confidenceScore, sampleWonDeals, aiRationale
    cur.execute("SELECT COUNT(*) FROM icp_profiles WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding ICP profile...")
        cur.execute("""INSERT INTO icp_profiles
                       (workspaceId, version, targetIndustries, targetCompanySizeMin,
                        targetCompanySizeMax, targetTitles, targetGeographies,
                        topConversionSignals, avgDealValue, avgSalesCycleDays,
                        confidenceScore, sampleWonDeals, aiRationale, isActive, createdAt)
                       VALUES (%s,1,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,NOW())""",
                    (WS,
                     json.dumps(["SaaS","Technology","FinTech"]),
                     50, 500,
                     json.dumps(["VP Revenue Operations","Director Revenue Operations",
                                 "Head of RevOps","Chief Revenue Officer"]),
                     json.dumps(["Northeast","West","Midwest"]),
                     json.dumps(["Hiring RevOps headcount","Recent funding round",
                                 "Evaluating CRM consolidation","Rapid headcount growth"]),
                     "48000.00", 62, 78, 15,
                     "Analysis of 15 won deals shows strong fit with mid-market SaaS RevOps leaders "
                     "at companies 50–500 employees. Key signals: recent hiring, funding events, "
                     "and multi-tool consolidation intent."))
        c.commit()
        print("  Seeded 1 ICP profile")

    # ── Brand voice ───────────────────────────────────────────────────────────
    # Correct columns: workspaceId (PK), tone (enum), vocabulary, avoidWords,
    #                  signatureHtml, fromName, fromEmail, primaryColor, secondaryColor, applyToAI
    cur.execute("SELECT COUNT(*) FROM brand_voice_profiles WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding brand voice profile...")
        cur.execute("""INSERT INTO brand_voice_profiles
                       (workspaceId, tone, vocabulary, avoidWords, fromName, fromEmail,
                        primaryColor, secondaryColor, applyToAI, updatedAt)
                       VALUES (%s,'direct',%s,%s,%s,%s,'#14B89A','#0F766E',1,NOW())""",
                    (WS,
                     json.dumps(["pipeline","revenue","signal","velocity","precision",
                                 "playbook","forecast","champion"]),
                     json.dumps(["synergy","leverage","paradigm","circle back",
                                 "touch base","move the needle","boil the ocean"]),
                     "Idris Grant", "idris.grant@lsi-media.com"))
        c.commit()
        print("  Seeded brand voice profile")

    # ── ARE campaigns ─────────────────────────────────────────────────────────
    cur.execute("SELECT COUNT(*) FROM are_campaigns WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding ARE campaigns...")
        cur.execute("SELECT id FROM icp_profiles WHERE workspaceId=%s LIMIT 1", (WS,))
        icp_row = cur.fetchone()
        icp_id = icp_row[0] if icp_row else None

        for are in [
            {"name": "Enterprise ABM — Q2 2026",
             "description": "Fully autonomous outbound targeting VP RevOps at mid-market SaaS.",
             "status": "active",
             "autonomyMode": "full",
             "dailySendCap": 50,
             "goalType": "meeting_booked",
             "prospectsDiscovered": randint(80,200),
             "prospectsEnrolled": randint(40,80),
             "prospectsContacted": randint(30,60),
             "prospectsReplied": randint(5,15),
             "meetingsBooked": randint(2,8)},
            {"name": "Churn prevention — at-risk tier",
             "description": "AI-driven re-engagement for at-risk customer accounts.",
             "status": "active",
             "autonomyMode": "batch_approval",
             "dailySendCap": 20,
             "goalType": "reply",
             "prospectsDiscovered": randint(30,60),
             "prospectsEnrolled": randint(15,30),
             "prospectsContacted": randint(10,25),
             "prospectsReplied": randint(3,10),
             "meetingsBooked": randint(1,4)},
            {"name": "Expansion — analytics upsell",
             "description": "Upsell Revenue Intelligence add-on to existing Core customers.",
             "status": "draft",
             "autonomyMode": "review_release",
             "dailySendCap": 30,
             "goalType": "opportunity_created",
             "prospectsDiscovered": 0,
             "prospectsEnrolled": 0,
             "prospectsContacted": 0,
             "prospectsReplied": 0,
             "meetingsBooked": 0},
        ]:
            cur.execute("""INSERT INTO are_campaigns
                           (workspaceId, name, description, status, autonomyMode,
                            icpProfileId, dailySendCap, channelsEnabled, goalType,
                            prospectsDiscovered, prospectsEnrolled, prospectsContacted,
                            prospectsReplied, meetingsBooked,
                            ownerUserId, createdAt, updatedAt)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                        (WS, are["name"], are["description"], are["status"],
                         are["autonomyMode"], icp_id, are["dailySendCap"],
                         json.dumps(["email","linkedin"]),
                         are["goalType"],
                         are["prospectsDiscovered"], are["prospectsEnrolled"],
                         are["prospectsContacted"], are["prospectsReplied"],
                         are["meetingsBooked"], OWN))
        c.commit()
        print("  Seeded 3 ARE campaigns")

    # ── Sending accounts ──────────────────────────────────────────────────────
    # Correct columns: workspaceId, name, provider (enum), fromEmail, fromName,
    #                  dailySendLimit, warmupStatus, connectionStatus, enabled
    cur.execute("SELECT COUNT(*) FROM sending_accounts WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding sending accounts...")
        for sender in [
            ("Idris Grant — Gmail",  "gmail_oauth",   "idris.grant@lsi-media.com", "Idris Grant"),
            ("LSI Media Sales",      "generic_smtp",  "sales@lsi-media.com",       "LSI Media Sales"),
            ("LSI Media Hello",      "generic_smtp",  "hello@lsi-media.com",       "LSI Media"),
        ]:
            cur.execute("""INSERT INTO sending_accounts
                           (workspaceId, name, provider, fromEmail, fromName,
                            dailySendLimit, warmupStatus, connectionStatus, enabled,
                            createdAt, updatedAt)
                           VALUES (%s,%s,%s,%s,%s,200,'complete','connected',1,NOW(),NOW())""",
                        (WS, sender[0], sender[1], sender[2], sender[3]))
        c.commit()
        print("  Seeded 3 sending accounts")

    # ── Dashboard ─────────────────────────────────────────────────────────────
    cur.execute("SELECT COUNT(*) FROM dashboards WHERE workspaceId=%s", (WS,))
    if cur.fetchone()[0] == 0:
        print("Seeding dashboard...")
        cur.execute("""INSERT INTO dashboards
                       (workspaceId, name, description, isShared, layout, ownerUserId,
                        createdAt, updatedAt)
                       VALUES (%s,%s,%s,1,%s,%s,NOW(),NOW())""",
                    (WS, "Revenue overview",
                     "Default starter dashboard — pipeline, won, top accounts.",
                     json.dumps([]), OWN))
        dash_id = cur.lastrowid
        for w in [
            ("kpi",    "Pipeline value",   {"metric":"pipeline_value"},           {"x":0,"y":0,"w":3,"h":2}),
            ("kpi",    "Closed won (qtr)", {"metric":"closed_won_qtr"},           {"x":3,"y":0,"w":3,"h":2}),
            ("kpi",    "Win rate",         {"metric":"win_rate"},                 {"x":6,"y":0,"w":3,"h":2}),
            ("kpi",    "Avg deal size",    {"metric":"avg_deal"},                 {"x":9,"y":0,"w":3,"h":2}),
            ("funnel", "Pipeline funnel",  {"dim":"stage"},                       {"x":0,"y":2,"w":6,"h":4}),
            ("bar",    "Won by month",     {"metric":"closed_won","dim":"month"}, {"x":6,"y":2,"w":6,"h":4}),
            ("table",  "Top accounts",     {"entity":"accounts","limit":5},       {"x":0,"y":6,"w":12,"h":4}),
        ]:
            cur.execute("""INSERT INTO dashboard_widgets
                           (workspaceId, dashboardId, type, title, config, position, createdAt)
                           VALUES (%s,%s,%s,%s,%s,%s,NOW())""",
                        (WS, dash_id, w[0], w[1], json.dumps(w[2]), json.dumps(w[3])))
        c.commit()
        print("  Seeded dashboard + 7 widgets")

    # ── Final count ───────────────────────────────────────────────────────────
    print("\n✅ Supplemental seed complete. Final counts:")
    for table in ["accounts","contacts","leads","opportunities","customers","sequences",
                  "campaigns","are_campaigns","products","quotes","proposals","tasks",
                  "workflow_rules","social_posts","audience_segments","email_snippets",
                  "email_templates","icp_profiles","brand_voice_profiles","sending_accounts",
                  "activities","dashboards"]:
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE workspaceId=%s", (WS,))
        count = cur.fetchone()[0]
        print(f"  {table:<30} {count}")

    cur.close()
    c.close()

if __name__ == "__main__":
    main()
