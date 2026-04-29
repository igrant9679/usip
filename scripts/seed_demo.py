#!/usr/bin/env python3
"""
USIP Demo Seeder — populates every major section of the app with realistic B2B SaaS data.
Workspace ID: 2, Owner User ID: 2
"""

import mysql.connector
import random
import json
from datetime import datetime, timedelta

DB = dict(host="shuttle.proxy.rlwy.net", port=28411, user="usip_user",
          password="usip_db_pass_2024", database="usip")

WS = 2   # workspaceId
OWN = 2  # ownerUserId

def conn():
    return mysql.connector.connect(**DB)

def days(d):
    return datetime.now() + timedelta(days=d)

def rand(lst):
    return random.choice(lst)

def randint(a, b):
    return random.randint(a, b)

# ─── Company data ────────────────────────────────────────────────────────────

COMPANIES = [
    {"name": "Axiom Revenue Group",    "domain": "axiomrg.com",       "industry": "SaaS",          "region": "Northeast", "size": "200-500"},
    {"name": "Cascade Analytics",      "domain": "cascadeai.io",      "industry": "SaaS",          "region": "West",      "size": "50-200"},
    {"name": "Meridian Health Systems","domain": "meridianhs.com",    "industry": "Healthcare",    "region": "Midwest",   "size": "1000-5000"},
    {"name": "Northline Capital",      "domain": "northlinecap.com",  "industry": "Finance",       "region": "Northeast", "size": "500-1000"},
    {"name": "Borealis Logistics",     "domain": "borealis.io",       "industry": "Logistics",     "region": "West",      "size": "200-500"},
    {"name": "Stonehaven Insurance",   "domain": "stonehaven-ins.com","industry": "Insurance",     "region": "South",     "size": "500-1000"},
    {"name": "Halcyon Analytics",      "domain": "halcyon.ai",        "industry": "SaaS",          "region": "West",      "size": "50-200"},
    {"name": "Ironpeak Manufacturing", "domain": "ironpeak.co",       "industry": "Manufacturing", "region": "Midwest",   "size": "1000-5000"},
    {"name": "Kestrel Biotech",        "domain": "kestrelbio.com",    "industry": "Biotech",       "region": "Northeast", "size": "50-200"},
    {"name": "Ridgemark Partners",     "domain": "ridgemark.com",     "industry": "Consulting",    "region": "South",     "size": "200-500"},
    {"name": "Pomelo Software",        "domain": "pomelo.dev",        "industry": "SaaS",          "region": "West",      "size": "50-200"},
    {"name": "Summit Trust Bank",      "domain": "summittrust.com",   "industry": "Finance",       "region": "Northeast", "size": "5000+"},
]

FIRST = ["Ava","Noah","Liam","Maya","Eli","Zara","Owen","Priya","Ethan","Nia",
         "Leo","Iris","Kai","Sana","Mateo","Ana","Ravi","Jade","Cyrus","Grace",
         "Jonas","Nadia","Theo","Amara","Idris","Daria","Nico","Yumi","Malik","Esme"]
LAST  = ["Okafor","Chen","Lindgren","Shah","Mercer","Bishara","Silva","Ortega",
         "Novak","Park","Romano","Adebayo","Hayashi","Kerry","Abrams","Knox",
         "Vance","Seidl","Dumont","Kurtz","Pires","Amaya","Trent","Holloway"]
TITLES = ["Chief Revenue Officer","VP of Sales","VP of Marketing","VP of Operations",
          "Director of Revenue Operations","Director of Partnerships","Head of Growth",
          "Senior Manager Revenue Operations","Director of Marketing","Chief Technology Officer",
          "Chief Financial Officer","Chief Executive Officer"]

SOURCES = ["LinkedIn","Referral","Inbound","Event","Cold outbound","CSV import"]
STAGES  = ["discovery","qualified","proposal","negotiation","won","lost"]

def main():
    c = conn()
    cur = c.cursor()

    print("Seeding territories...")
    territory_ids = []
    for name in ["Northeast","Midwest","South","West"]:
        cur.execute("""INSERT INTO territories (workspaceId, name, ownerUserId, rules, createdAt)
                       VALUES (%s,%s,%s,%s,NOW())""",
                    (WS, name, OWN, json.dumps({"regions": [name]})))
        territory_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding accounts...")
    account_ids = []
    for co in COMPANIES:
        arr = randint(50, 500) * 1000
        cur.execute("""INSERT INTO accounts
                       (workspaceId, name, domain, industry, employeeBand, revenueBand,
                        region, arr, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, co["name"], co["domain"], co["industry"], co["size"],
                     rand(["$10M-50M","$50M-200M","$200M-1B","$1B+"]),
                     co["region"], str(arr), OWN))
        account_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding contacts...")
    contact_ids = []
    for acc_id in account_ids:
        for i in range(randint(2, 4)):
            fn = rand(FIRST)
            ln = rand(LAST)
            email = f"{fn.lower()}.{ln.lower().replace(' ','')}@example.com"
            cur.execute("""INSERT INTO contacts
                           (workspaceId, accountId, firstName, lastName, title, email,
                            phone, seniority, isPrimary, ownerUserId, createdAt, updatedAt)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                        (WS, acc_id, fn, ln, rand(TITLES), email,
                         f"+1-555-{randint(100,999)}-{randint(1000,9999)}",
                         rand(["C-Level","VP","Director","Manager"]),
                         1 if i == 0 else 0, OWN))
            contact_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding leads...")
    lead_ids = []
    for i in range(40):
        fn = rand(FIRST)
        ln = rand(LAST)
        co = rand(COMPANIES)
        score = randint(10, 95)
        grade = "A" if score >= 80 else "B" if score >= 60 else "C" if score >= 40 else "D"
        status = rand(["new","new","working","qualified","unqualified"])
        cur.execute("""INSERT INTO leads
                       (workspaceId, firstName, lastName, email, phone, company, title,
                        source, status, score, grade, scoreReasons, tags, ownerUserId,
                        createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, fn, ln,
                     f"{fn.lower()}.{ln.lower().replace(' ','')}@{co['domain']}",
                     f"+1-555-{randint(100,999)}-{randint(1000,9999)}",
                     co["name"], rand(TITLES), rand(SOURCES), status,
                     score, grade,
                     json.dumps([
                         "Senior title (+15)" if score >= 60 else "Mid-level title (+5)",
                         "Engaged with email (+10)",
                         "Visited pricing page (+12)" if score >= 70 else "Visited blog (+3)",
                     ]),
                     json.dumps(["ICP-fit"]), OWN))
        lead_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding opportunities...")
    opp_ids = []
    opp_stage_map = {}
    stage_list = ["discovery","qualified","proposal","negotiation","won","won","lost"]
    for i in range(32):
        stage = rand(stage_list)
        value = randint(15, 380) * 1000
        wp = (100 if stage == "won" else 0 if stage == "lost" else
              randint(60,90) if stage == "negotiation" else
              randint(40,70) if stage == "proposal" else
              randint(25,55) if stage == "qualified" else randint(10,35))
        acc_id = rand(account_ids)
        acc_name = COMPANIES[account_ids.index(acc_id)]["name"]
        close_date = days(-randint(1,60)) if stage in ("won","lost") else days(randint(5,90))
        cur.execute("""INSERT INTO opportunities
                       (workspaceId, accountId, name, stage, value, winProb, closeDate,
                        daysInStage, aiNote, nextStep, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, acc_id,
                     f"{acc_name} – {rand(['Annual subscription','Pilot expansion','Renewal + upsell','Multi-year deal','Strategic partnership'])}",
                     stage, str(value), wp, close_date, randint(2,35),
                     rand(["Champion confirmed.","Awaiting legal review.","Procurement engaged.",
                           "Pricing pushback expected.","Multi-thread in progress."]),
                     rand(["Send revised quote","Schedule exec sponsor sync",
                           "Confirm security review","Finalize MSA terms"]),
                     OWN))
        oid = cur.lastrowid
        opp_ids.append(oid)
        opp_stage_map[oid] = (stage, value, acc_id)
    c.commit()

    # Opportunity contact roles
    for oid in opp_ids[:20]:
        sample = random.sample(contact_ids, min(2, len(contact_ids)))
        for i, cid in enumerate(sample):
            try:
                cur.execute("""INSERT INTO opportunity_contact_roles
                               (workspaceId, opportunityId, contactId, role, isPrimary, createdAt)
                               VALUES (%s,%s,%s,%s,%s,NOW())""",
                            (WS, oid, cid,
                             "champion" if i == 0 else "decision_maker",
                             1 if i == 0 else 0))
            except:
                pass
    c.commit()

    print("Seeding products...")
    product_ids = []
    for prod in [
        ("USIP-CORE-A",    "Velocity Core (Annual)",              "12000", "annual",    "Platform"),
        ("USIP-CORE-M",    "Velocity Core (Monthly)",             "1200",  "monthly",   "Platform"),
        ("USIP-INTEL",     "Revenue Intelligence add-on",         "6000",  "annual",    "Add-on"),
        ("USIP-SOCIAL",    "Social Publishing module",            "4800",  "annual",    "Add-on"),
        ("USIP-CS",        "Customer Success module",             "5400",  "annual",    "Add-on"),
        ("USIP-IMPL-PRO",  "Implementation — Professional",       "8500",  "one_time",  "Services"),
        ("USIP-IMPL-ENT",  "Implementation — Enterprise",         "22500", "one_time",  "Services"),
        ("USIP-TRAINING",  "Admin training (per session)",        "2500",  "one_time",  "Services"),
    ]:
        try:
            cur.execute("""INSERT INTO products
                           (workspaceId, sku, name, listPrice, billingCycle, category,
                            active, createdAt)
                           VALUES (%s,%s,%s,%s,%s,%s,1,NOW())""",
                        (WS, prod[0], prod[1], prod[2], prod[3], prod[4]))
            product_ids.append(cur.lastrowid)
        except:
            cur.execute("SELECT id FROM products WHERE workspaceId=%s AND sku=%s", (WS, prod[0]))
            row = cur.fetchone()
            if row:
                product_ids.append(row[0])
    c.commit()

    print("Seeding customers (from won opps)...")
    customer_ids = []
    won_opps = [(oid, v, aid) for oid,(s,v,aid) in opp_stage_map.items() if s == "won"]
    for oid, value, acc_id in won_opps:
        start = days(-randint(60, 600))
        end   = start + timedelta(days=365)
        usage = randint(30, 95)
        eng   = randint(25, 95)
        supp  = randint(40, 95)
        nps   = randint(-20, 70)
        score = round(usage*0.35 + eng*0.25 + supp*0.2 + ((nps+100)/2)*0.2)
        tier  = ("healthy" if score >= 75 else "watch" if score >= 55 else
                 "at_risk" if score >= 35 else "critical")
        days_to_renewal = (end - datetime.now()).days
        renewal_stage = ("renewed" if days_to_renewal < 0 else
                         "thirty" if days_to_renewal <= 30 else
                         "sixty"  if days_to_renewal <= 60 else
                         "ninety" if days_to_renewal <= 90 else "early")
        cur.execute("""INSERT INTO customers
                       (workspaceId, accountId, arr, contractStart, contractEnd, tier,
                        cmUserId, healthScore, healthTier, usageScore, engagementScore,
                        supportScore, npsScore, npsHistory, expansionPotential, aiPlay,
                        renewalStage, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, acc_id, str(value), start, end,
                     rand(["enterprise","midmarket","smb"]),
                     OWN, score, tier, usage, eng, supp, nps,
                     json.dumps([{"month": i, "score": max(-100, min(100, nps + randint(-15,15)))} for i in range(6)]),
                     str(randint(10,80)*1000),
                     ("Immediate exec outreach + roadmap review" if tier in ("critical","at_risk") else
                      "Schedule QBR with usage deep-dive" if tier == "watch" else
                      "Identify expansion via team-licensing pitch"),
                     renewal_stage))
        cust_id = cur.lastrowid
        customer_ids.append(cust_id)

        # Support tickets
        for _ in range(randint(0, 3)):
            cur.execute("""INSERT INTO support_tickets
                           (workspaceId, customerId, subject, severity, status, openedAt)
                           VALUES (%s,%s,%s,%s,%s,NOW())""",
                        (WS, cust_id,
                         rand(["SSO config issue","Reporting export bug","API rate limit raised",
                               "Onboarding question","Data sync delay","Dashboard not loading"]),
                         rand(["low","medium","high"]),
                         rand(["open","resolved","closed"])))

        # Contract amendments
        if random.random() > 0.5:
            cur.execute("""INSERT INTO contract_amendments
                           (workspaceId, customerId, type, arrDelta, effectiveAt, notes,
                            createdByUserId, createdAt)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())""",
                        (WS, cust_id,
                         rand(["upgrade","addon","renewal"]),
                         str(randint(5,40)*1000),
                         days(-randint(30,200)),
                         "Annual true-up", OWN))

        # QBR
        if random.random() > 0.4:
            cur.execute("""INSERT INTO qbrs
                           (workspaceId, customerId, scheduledAt, status, aiPrep, createdAt)
                           VALUES (%s,%s,%s,%s,%s,NOW())""",
                        (WS, cust_id, days(randint(7,60)), "scheduled",
                         json.dumps({"wins": ["Adoption up 23% QoQ"],
                                     "risks": ["Champion role change"],
                                     "asks": ["Expand to 2nd team"]})))
    c.commit()

    print("Seeding sequences...")
    seq_ids = []
    for seq in [
        {"name": "Cold outbound — VP RevOps",
         "steps": [{"type":"email","subject":"Quick question"},{"type":"wait","days":3},
                   {"type":"email","subject":"Re: quick question"},{"type":"wait","days":4},
                   {"type":"task","body":"LinkedIn connection"}]},
        {"name": "Inbound nurture — pricing page visit",
         "steps": [{"type":"email","subject":"Saw you visited pricing"},{"type":"wait","days":2},
                   {"type":"email","subject":"Demo this week?"}]},
        {"name": "Champion re-engagement",
         "steps": [{"type":"email","subject":"Catching up"},{"type":"wait","days":5},
                   {"type":"email","subject":"Resource share"}]},
        {"name": "Post-demo follow-up",
         "steps": [{"type":"email","subject":"Great chatting — next steps"},{"type":"wait","days":3},
                   {"type":"task","body":"Follow up call"},{"type":"wait","days":4},
                   {"type":"email","subject":"Still exploring options?"}]},
    ]:
        cur.execute("""INSERT INTO sequences
                       (workspaceId, name, status, steps, ownerUserId, enrolledCount,
                        createdAt, updatedAt)
                       VALUES (%s,%s,'active',%s,%s,%s,NOW(),NOW())""",
                    (WS, seq["name"], json.dumps(seq["steps"]), OWN, randint(8,30)))
        seq_ids.append(cur.lastrowid)
    c.commit()

    # Enrollments
    for cid in contact_ids[:20]:
        cur.execute("""INSERT INTO enrollments
                       (workspaceId, sequenceId, contactId, status, currentStep,
                        startedAt, nextActionAt)
                       VALUES (%s,%s,%s,'active',%s,NOW(),%s)""",
                    (WS, rand(seq_ids), cid, randint(0,2), days(randint(0,7))))
    c.commit()

    print("Seeding email drafts...")
    for i in range(10):
        cur.execute("""INSERT INTO email_drafts
                       (workspaceId, subject, body, toContactId, status, aiGenerated,
                        aiPrompt, createdByUserId, createdAt)
                       VALUES (%s,%s,%s,%s,%s,1,%s,%s,NOW())""",
                    (WS,
                     rand(["Following up on our chat","Quick question on your priorities",
                           "Resource that might help","Re: pricing discussion",
                           "Saw you at SaaStr","Intro from mutual connection"]),
                     "Hi {{firstName}},\n\nNoticed you're working on revenue ops modernization. "
                     "Curious how you're handling pipeline visibility today — happy to share "
                     "what we're seeing.\n\nWorth 15 minutes?\n\nBest,\n{{senderName}}",
                     rand(contact_ids),
                     rand(["pending_review","pending_review","ai_pending_review"]),
                     "Write a short follow-up email to a VP of RevOps after a discovery call.",
                     OWN))
    c.commit()

    print("Seeding tasks...")
    for i in range(20):
        cur.execute("""INSERT INTO tasks
                       (workspaceId, title, type, priority, status, dueAt,
                        ownerUserId, relatedType, relatedId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,'open',%s,%s,%s,%s,NOW(),NOW())""",
                    (WS,
                     rand(["Call champion","Send pricing breakdown",
                           "Confirm security review timing","Schedule QBR",
                           "Draft renewal proposal","Follow up on POC results",
                           "Prepare exec briefing","Send contract redlines"]),
                     rand(["call","email","meeting","todo","follow_up"]),
                     rand(["normal","normal","high","urgent"]),
                     days(randint(-2,14)), OWN,
                     "opportunity", rand(opp_ids)))
    c.commit()

    print("Seeding workflow rules...")
    for wf in [
        {"name": "Auto-assign new leads to RevOps",
         "triggerType": "record_created",
         "triggerConfig": {"entity": "lead"},
         "conditions": [{"field": "score", "op": ">=", "value": 60}],
         "actions": [{"type": "update_field", "params": {"field": "ownerUserId", "value": OWN}}]},
        {"name": "Flag stalled deals after 14 days",
         "triggerType": "schedule",
         "triggerConfig": {"cron": "0 9 * * *"},
         "conditions": [{"field": "daysInStage", "op": ">=", "value": 14},
                        {"field": "stage", "op": "in", "value": ["proposal","negotiation"]}],
         "actions": [{"type": "create_task", "params": {"title": "Re-engage stalled deal", "priority": "high"}},
                     {"type": "notify", "params": {"kind": "system"}}]},
        {"name": "Churn risk escalation",
         "triggerType": "field_equals",
         "triggerConfig": {"entity": "customer", "field": "healthTier", "value": "critical"},
         "conditions": [],
         "actions": [{"type": "create_task", "params": {"title": "Churn intervention", "priority": "urgent"}}]},
        {"name": "Welcome email on lead creation",
         "triggerType": "record_created",
         "triggerConfig": {"entity": "lead"},
         "conditions": [{"field": "source", "op": "=", "value": "Inbound"}],
         "actions": [{"type": "enroll_sequence", "params": {"sequenceId": seq_ids[1] if seq_ids else 1}}]},
    ]:
        cur.execute("""INSERT INTO workflow_rules
                       (workspaceId, name, enabled, triggerType, triggerConfig,
                        conditions, actions, fireCount, lastFiredAt, createdAt, updatedAt)
                       VALUES (%s,%s,1,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, wf["name"], wf["triggerType"],
                     json.dumps(wf["triggerConfig"]),
                     json.dumps(wf["conditions"]),
                     json.dumps(wf["actions"]),
                     randint(3,25), days(-randint(0,5))))
    c.commit()

    print("Seeding social accounts...")
    sa_ids = []
    for p in [
        ("linkedin",  "lsi-media",  "LSI Media"),
        ("twitter",   "lsimedia",   "LSI Media"),
        ("facebook",  "lsimedia",   "LSI Media"),
        ("instagram", "lsi.media",  "LSI Media"),
    ]:
        cur.execute("""INSERT INTO social_accounts
                       (workspaceId, platform, handle, displayName, connected,
                        accessTokenStub, connectedAt, createdAt)
                       VALUES (%s,%s,%s,%s,1,%s,NOW(),NOW())""",
                    (WS, p[0], p[1], p[2], "stub_" + str(random.random())[:8]))
        sa_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding social posts...")
    POSTS = [
        "How modern revenue ops teams are consolidating their tool stack — 3 patterns we see weekly.",
        "Quick reminder: pipeline hygiene > pipeline volume. A clean $400k beats a messy $1.2M.",
        "We just shipped multi-workspace support. Real one.",
        "If your CRM doesn't tell you what to do next, it's a database with extra steps.",
        "Three customer success metrics that actually predict renewal — and which ones are vanity.",
        "Unpopular take: the best growth lever for most teams isn't a new tool, it's a deleted process.",
        "The average enterprise sales cycle is 84 days. The top 10% close in 31. Here's the diff.",
        "Your champion just got promoted. Now what? A 3-step playbook.",
    ]
    for i in range(14):
        status = rand(["draft","in_review","approved","scheduled","scheduled","published","published"])
        sched  = days(-randint(1,14)) if status == "published" else days(randint(0,14))
        cur.execute("""INSERT INTO social_posts
                       (workspaceId, socialAccountId, platform, body, status,
                        scheduledFor, publishedAt, impressions, engagements, clicks,
                        authorUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, rand(sa_ids),
                     rand(["linkedin","twitter","facebook","instagram"]),
                     rand(POSTS), status, sched,
                     sched if status == "published" else None,
                     randint(800,18000) if status == "published" else 0,
                     randint(20,600)    if status == "published" else 0,
                     randint(5,200)     if status == "published" else 0,
                     OWN))
    c.commit()

    print("Seeding campaigns...")
    campaign_ids = []
    for camp in [
        {"name": "Q2 Renewal Push",         "objective": "renewal",    "status": "live",      "desc": "Coordinated campaign to lift Q2 renewals across the watch tier."},
        {"name": "Mid-market expansion",     "objective": "expansion",  "status": "scheduled", "desc": "Cross-sell analytics module to top 50 mid-market accounts."},
        {"name": "Spring brand refresh",     "objective": "awareness",  "status": "planning",  "desc": "Multi-channel awareness push around new brand identity."},
        {"name": "Inbound nurture — Q3",     "objective": "nurture",    "status": "live",      "desc": "Automated nurture track for all pricing-page visitors."},
        {"name": "Enterprise ABM — Tier 1",  "objective": "pipeline",   "status": "scheduled", "desc": "Account-based outreach to 20 target enterprise logos."},
    ]:
        cur.execute("""INSERT INTO campaigns
                       (workspaceId, name, objective, status, startsAt, endsAt,
                        budget, targetSegment, description, checklist, ownerUserId,
                        totalSent, totalDelivered, totalOpened, totalClicked, totalReplied,
                        createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, camp["name"], camp["objective"], camp["status"],
                     days(-10 if camp["status"] == "live" else 14),
                     days(30  if camp["status"] == "live" else 45),
                     str(randint(15,80)*1000), "Watch-tier customers, midmarket",
                     camp["desc"],
                     json.dumps([
                         {"id":1,"label":"Owner assigned","done":True},
                         {"id":2,"label":"Budget approved","done": camp["status"] != "planning"},
                         {"id":3,"label":"Creative reviewed","done": camp["status"] == "live"},
                         {"id":4,"label":"Tracking links generated","done": camp["status"] == "live"},
                         {"id":5,"label":"Sequences enrolled","done": camp["status"] == "live"},
                     ]),
                     OWN,
                     randint(200,2000) if camp["status"] == "live" else 0,
                     randint(180,1900) if camp["status"] == "live" else 0,
                     randint(50,600)   if camp["status"] == "live" else 0,
                     randint(10,120)   if camp["status"] == "live" else 0,
                     randint(5,60)     if camp["status"] == "live" else 0))
        campaign_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding quotes...")
    quote_ids = []
    open_opps = [oid for oid,(s,v,aid) in opp_stage_map.items() if s in ("proposal","negotiation")]
    for i, oid in enumerate(open_opps[:8]):
        subtotal = randint(12,120)*1000
        discount = round(subtotal * 0.05, 2)
        tax      = round((subtotal - discount) * 0.08, 2)
        total    = subtotal - discount + tax
        qnum     = f"Q-2026-{1001+i}"
        status   = rand(["draft","sent","accepted"])
        cur.execute("""INSERT INTO quotes
                       (workspaceId, opportunityId, quoteNumber, status, expiresAt,
                        subtotal, discountTotal, taxTotal, total, notes,
                        createdByUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, oid, qnum, status, days(30),
                     str(subtotal), str(discount), str(tax), str(total),
                     "Standard enterprise terms apply.", OWN))
        qid = cur.lastrowid
        quote_ids.append(qid)

        # Quote line items
        for prod_id in random.sample(product_ids[:5], min(3, len(product_ids[:5]))):
            qty = randint(1,5)
            unit = randint(5,25)*1000
            cur.execute("""INSERT INTO quote_line_items
                           (workspaceId, quoteId, productId, name, quantity,
                            unitPrice, discountPct, lineTotal)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (WS, qid, prod_id,
                         rand(["Velocity Core (Annual)","Revenue Intelligence add-on",
                               "Customer Success module","Implementation — Professional"]),
                         qty, str(unit), "5.00", str(qty*unit*0.95)))
    c.commit()

    print("Seeding proposals...")
    for i, oid in enumerate(open_opps[:6]):
        acc_id = opp_stage_map[oid][2]
        acc_name = COMPANIES[account_ids.index(acc_id)]["name"] if acc_id in account_ids else "Client"
        cur.execute("""INSERT INTO proposals
                       (workspaceId, opportunityId, title, status, clientName,
                        clientEmail, expiresAt, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, oid,
                     f"{acc_name} — Revenue Platform Proposal",
                     rand(["draft","sent","viewed"]),
                     acc_name,
                     f"procurement@{rand(COMPANIES)['domain']}",
                     days(30), OWN))
    c.commit()

    print("Seeding email snippets...")
    for snip in [
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
    ]:
        cur.execute("""INSERT INTO email_snippets
                       (workspaceId, name, body, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, snip[0], snip[1], OWN))
    c.commit()

    print("Seeding email templates...")
    for tmpl in [
        ("Cold outreach — VP RevOps",
         "Quick question about {{company}}",
         "Hi {{firstName}},\n\nI noticed {{company}} has been scaling its revenue team — congrats on the growth.\n\nWe help RevOps leaders at companies like yours consolidate pipeline, engagement, and CS data into a single platform. The result is usually a 20–30% improvement in forecast accuracy within the first quarter.\n\nWorth a 20-minute conversation?\n\nBest,\n{{senderName}}"),
        ("Post-demo follow-up",
         "Next steps after our call",
         "Hi {{firstName}},\n\nGreat speaking with you today. As promised, here's a summary of what we covered:\n\n• {{summaryPoint1}}\n• {{summaryPoint2}}\n• {{summaryPoint3}}\n\nI'll send over the proposal by end of week. In the meantime, feel free to reach out with any questions.\n\nBest,\n{{senderName}}"),
        ("Renewal reminder — 90 days out",
         "Your {{product}} renewal is coming up",
         "Hi {{firstName}},\n\nYour {{product}} subscription renews on {{renewalDate}} — just wanted to give you a heads-up with plenty of time to review.\n\nWould love to schedule a quick call to review your usage, share what's new on the roadmap, and make sure you're getting maximum value.\n\nBest,\n{{senderName}}"),
    ]:
        cur.execute("""INSERT INTO email_templates
                       (workspaceId, name, subject, body, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, tmpl[0], tmpl[1], tmpl[2], OWN))
    c.commit()

    print("Seeding audience segments...")
    seg_ids = []
    for seg in [
        ("Watch-tier customers",
         {"logic":"AND","rules":[{"field":"healthTier","op":"=","value":"watch"}]},
         "customers"),
        ("High-score leads (B+)",
         {"logic":"AND","rules":[{"field":"score","op":">=","value":60}]},
         "leads"),
        ("Mid-market SaaS accounts",
         {"logic":"AND","rules":[{"field":"industry","op":"=","value":"SaaS"},
                                  {"field":"employeeBand","op":"in","value":["50-200","200-500"]}]},
         "accounts"),
        ("Open proposals — expiring soon",
         {"logic":"AND","rules":[{"field":"status","op":"in","value":["sent","viewed"]},
                                  {"field":"expiresAt","op":"lt","value":"30d"}]},
         "proposals"),
    ]:
        cur.execute("""INSERT INTO audience_segments
                       (workspaceId, name, filters, entityType, ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, seg[0], json.dumps(seg[1]), seg[2], OWN))
        seg_ids.append(cur.lastrowid)
    c.commit()

    print("Seeding ICP profiles...")
    cur.execute("""INSERT INTO icp_profiles
                   (workspaceId, name, description, firmographics, painPoints,
                    buyingSignals, ownerUserId, createdAt, updatedAt)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                (WS,
                 "Mid-market B2B SaaS RevOps Leader",
                 "VP or Director of Revenue Operations at a B2B SaaS company with 50–500 employees, "
                 "managing a fragmented tech stack and struggling with forecast accuracy.",
                 json.dumps({"industries":["SaaS","Technology"],
                             "employeeBands":["50-200","200-500"],
                             "titles":["VP Revenue Operations","Director Revenue Operations",
                                       "Head of RevOps","Chief Revenue Officer"],
                             "regions":["Northeast","West","Midwest"]}),
                 json.dumps(["Fragmented data across 5+ tools",
                             "Manual pipeline reviews taking 4+ hours/week",
                             "No single source of truth for forecast",
                             "CS and Sales operating in silos"]),
                 json.dumps(["Hiring RevOps headcount","Evaluating CRM consolidation",
                             "Recent funding round","Rapid headcount growth"]),
                 OWN))
    c.commit()

    print("Seeding brand voice profile...")
    cur.execute("""INSERT INTO brand_voice_profiles
                   (workspaceId, name, tone, vocabulary, avoidWords, exampleSentences,
                    isDefault, ownerUserId, createdAt, updatedAt)
                   VALUES (%s,%s,%s,%s,%s,%s,1,%s,NOW(),NOW())""",
                (WS,
                 "LSI Media — Default",
                 json.dumps(["confident","direct","data-driven","human","no-fluff"]),
                 json.dumps(["pipeline","revenue","signal","velocity","precision",
                             "playbook","forecast","champion"]),
                 json.dumps(["synergy","leverage","paradigm","circle back",
                             "touch base","move the needle","boil the ocean"]),
                 json.dumps(["We help revenue teams see what's coming before it arrives.",
                             "Your pipeline is a prediction — we make it accurate.",
                             "Less noise. More signal. Faster close."]),
                 OWN))
    c.commit()

    print("Seeding ARE campaigns...")
    for are in [
        {"name": "Enterprise ABM — Q2 2026",
         "objective": "pipeline",
         "status": "active",
         "targetPersona": "VP Revenue Operations",
         "targetIndustries": ["SaaS","Technology"],
         "targetSizes": ["200-500","500-1000"],
         "dailyLimit": 50,
         "description": "Fully autonomous outbound targeting VP RevOps at mid-market SaaS."},
        {"name": "Churn prevention — at-risk tier",
         "objective": "retention",
         "status": "active",
         "targetPersona": "Customer Success Manager",
         "targetIndustries": ["SaaS","Healthcare","Finance"],
         "targetSizes": ["50-200","200-500"],
         "dailyLimit": 20,
         "description": "AI-driven re-engagement for at-risk customer accounts."},
        {"name": "Expansion — analytics upsell",
         "objective": "expansion",
         "status": "draft",
         "targetPersona": "VP of Analytics",
         "targetIndustries": ["SaaS","Finance","Consulting"],
         "targetSizes": ["200-500","500-1000"],
         "dailyLimit": 30,
         "description": "Upsell Revenue Intelligence add-on to existing Core customers."},
    ]:
        cur.execute("""INSERT INTO are_campaigns
                       (workspaceId, name, objective, status, targetPersona,
                        targetIndustries, targetSizes, dailyLimit, description,
                        ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (WS, are["name"], are["objective"], are["status"],
                     are["targetPersona"],
                     json.dumps(are["targetIndustries"]),
                     json.dumps(are["targetSizes"]),
                     are["dailyLimit"], are["description"], OWN))
    c.commit()

    print("Seeding dashboards...")
    cur.execute("""INSERT INTO dashboards
                   (workspaceId, name, description, isShared, layout, ownerUserId,
                    createdAt, updatedAt)
                   VALUES (%s,%s,%s,1,%s,%s,NOW(),NOW())""",
                (WS, "Revenue overview",
                 "Default starter dashboard — pipeline, won, top accounts.",
                 json.dumps([]), OWN))
    dash_id = cur.lastrowid

    for w in [
        ("kpi",    "Pipeline value",      {"metric":"pipeline_value"},           {"x":0,"y":0,"w":3,"h":2}),
        ("kpi",    "Closed won (qtr)",    {"metric":"closed_won_qtr"},           {"x":3,"y":0,"w":3,"h":2}),
        ("kpi",    "Win rate",            {"metric":"win_rate"},                 {"x":6,"y":0,"w":3,"h":2}),
        ("kpi",    "Avg deal size",       {"metric":"avg_deal"},                 {"x":9,"y":0,"w":3,"h":2}),
        ("funnel", "Pipeline funnel",     {"dim":"stage"},                       {"x":0,"y":2,"w":6,"h":4}),
        ("bar",    "Won by month",        {"metric":"closed_won","dim":"month"}, {"x":6,"y":2,"w":6,"h":4}),
        ("table",  "Top accounts",        {"entity":"accounts","limit":5},       {"x":0,"y":6,"w":12,"h":4}),
    ]:
        cur.execute("""INSERT INTO dashboard_widgets
                       (workspaceId, dashboardId, type, title, config, position, createdAt)
                       VALUES (%s,%s,%s,%s,%s,%s,NOW())""",
                    (WS, dash_id, w[0], w[1], json.dumps(w[2]), json.dumps(w[3])))
    c.commit()

    print("Seeding activities (notes, calls, meetings)...")
    for i in range(20):
        rtype = rand(["account","contact","opportunity"])
        rid   = (rand(account_ids) if rtype == "account" else
                 rand(contact_ids) if rtype == "contact" else rand(opp_ids))
        atype = rand(["call","meeting","email","note"])
        cur.execute("""INSERT INTO activities
                       (workspaceId, type, relatedType, relatedId, subject, body,
                        callDisposition, callDurationSec, occurredAt, actorUserId, createdAt)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())""",
                    (WS, atype, rtype, rid,
                     rand(["Discovery call","Intro meeting","Pricing discussion",
                           "Champion sync","Executive briefing","QBR prep"]),
                     rand(["Strong interest in the platform. Champion is engaged.",
                           "Procurement wants a security review before moving forward.",
                           "Discussed expansion opportunity — 2nd team interested.",
                           "Followed up on proposal. Client reviewing internally.",
                           "Left voicemail. Will try again Thursday."]),
                     rand(["connected","voicemail","no_answer"]) if atype == "call" else None,
                     randint(120,1800) if atype == "call" else None,
                     days(-randint(0,30)), OWN))
    c.commit()

    print("Seeding sending accounts (email senders)...")
    for sender in [
        ("idris.grant@lsi-media.com", "Idris Grant"),
        ("sales@lsi-media.com",       "LSI Media Sales"),
        ("hello@lsi-media.com",       "LSI Media"),
    ]:
        cur.execute("""INSERT INTO sending_accounts
                       (workspaceId, email, displayName, status, dailyCap,
                        ownerUserId, createdAt, updatedAt)
                       VALUES (%s,%s,%s,'active',%s,%s,NOW(),NOW())""",
                    (WS, sender[0], sender[1], 200, OWN))
    c.commit()

    print("\n✅ Seed complete!")
    print(f"  Accounts:     {len(account_ids)}")
    print(f"  Contacts:     {len(contact_ids)}")
    print(f"  Leads:        40")
    print(f"  Opportunities:{len(opp_ids)}")
    print(f"  Customers:    {len(customer_ids)}")
    print(f"  Sequences:    {len(seq_ids)}")
    print(f"  Campaigns:    5")
    print(f"  ARE Campaigns:3")
    print(f"  Products:     8")
    print(f"  Quotes:       {len(quote_ids)}")
    print(f"  Proposals:    6")
    print(f"  Tasks:        20")
    print(f"  Workflows:    4")
    print(f"  Social posts: 14")
    print(f"  Segments:     {len(seg_ids)}")
    print(f"  Snippets:     5")
    print(f"  Activities:   20")

    cur.close()
    c.close()

if __name__ == "__main__":
    main()
