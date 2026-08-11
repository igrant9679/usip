# Confidence Vocabularies — the four scales and why they stay separate

> Roadmap P5.4. This DOCUMENTS the scales; converging them is an explicit
> non-goal (they answer different questions, and a merge would be a rewrite).

## 1. `fieldMerge.CONFIDENCE` — "how much do we trust this VALUE" (0–100)

The prospect **and** account field ledger scale (`prospects.field_provenance`,
`accounts.field_provenance` via the `accountProvenance` adapter).
One table, `server/services/enrichment/fieldMerge.ts`:

| Level | Value | Meaning |
|---|---|---|
| user | 100 | human-entered / pinned — nothing automated outranks it |
| emailReoonValid | 95 | Reoon `valid` verdict |
| quickenrichVerified | 92 | QuickEnrich hit, Reoon-verified |
| patternReoonValid | 90 | pattern-derived, Reoon-verified |
| linkedinProfile | 85 | LinkedIn profile fact — **also the company-identification tier** (owner decision 2026-08-11: QuickEnrich + LinkedIn are the single source of truth for company identification) |
| apolloDomain | 75 | Apollo name→domain resolution |
| preexisting | 70 | legacy value with no ledger entry — protected, correctable |
| emailDomain | 70 | domain lifted from the prospect's own business email |
| emailAcceptAll | 62 | Reoon `accept_all` |
| headlineParse | 60 | company parsed from a LinkedIn headline; also the single-sighting company-identification tier |
| scrapeFound | 55 | site scrape / discovery / campaign-scrape opportunistic finds |
| emailRisky / emailUnknown | 50 / 45 | Reoon verdicts |
| domainDerived | 40 | company name guessed from the domain root |

Rules: strictly-higher replaces; ties keep; agreement corroborates (+5, cap 99
— **except** the account adapter, where corroboration never lowers an existing
confidence, protecting user·100 pins); Reoon-`valid` emails yield only to a
newer `valid`. Reoon itself is the **optional final verification step**
(migration 0157) — toggled off, no candidate ever carries a verdict.

## 2. `brandReconciler.BRAND_THRESHOLDS` — "how sure is this brand MATCH"

Same 0–100 scale, different question: how confident is the *match* between a
Brand Search hit and an account. Bands (owner spec): ≥95 auto, 80–94 needs
corroboration from the account's own records, 60–79 candidate-only, <60
nothing. Its *writes* then flow through scale #1's ledger.

## 3. `matchingService` additive points — "is this the same COMPANY"

Company identity resolution: +100 domain, +95 LinkedIn URL / global org,
+50 exact name, +35 fuzzy/email-domain, −50 conflicting domain; bucketed
into exact/high/possible/no-match/conflict. Deliberately additive (multiple
weak signals can outweigh one medium), which a 0–100 trust scale can't model.

## 4. `contactAccountLinks.confidence` — link-record annotation

The score-at-link-time snapshot from scale #3, stored on the relationship
row. Historical annotation, not a live decision input.

## Email verification vocabularies (bonus fifth)

`prospects.emailStatus` (`valid | accept_all | risky | invalid | unknown`) is
Reoon's verdict; `contacts.emailVerificationStatus` uses the older
`safe | invalid | risky | catch_all | unknown` wording. Only `valid` promotes
(`PROMOTABLE_EMAIL_STATUSES`). And the UI label "Catch-all (generic inbox)"
is a LOCAL-PART property (`shared/genericEmail.ts`), NOT Reoon's `accept_all`
domain property — the words collide, the meanings don't.
