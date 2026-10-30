/**
 * placeFit.ts — is this person in the campaign's places? (F17, 2026-10-30)
 *
 * Generalises `quickenrichPlaceCheck`, which answers the same question for one
 * vendor and one shape of target. Two things it deliberately does differently:
 *
 *  1. **No targets means "unknown", never "elsewhere".** The QuickEnrich check
 *     cannot be called with an empty state list: `country && !states.some(...)`
 *     is true for every recognisable country, so everyone comes back
 *     "elsewhere". It is correct today only because the engine guards the call.
 *     Here the guard is the first line of the function, so the generalisation
 *     cannot inherit the trap.
 *  2. **"Elsewhere" needs positive evidence.** A verdict is only `elsewhere`
 *     when the person's place resolves to a country or a state that the targets
 *     exclude. Anything we merely cannot read is `unknown`, which will be the
 *     common answer: two discovery sources write an empty string for place,
 *     internal leads never have one, and QuickEnrich writes none at all unless
 *     its states route ran.
 *
 * A bare city is NOT resolved to its state or country. "Austin" with a Texas
 * target is `unknown`, not `inside`: we have no gazetteer, and guessing would
 * make the verdict's confident cases indistinguishable from its guesses. A bare
 * broad region ("Northeast") as a TARGET likewise matches nothing — widening a
 * *search* to the whole US for it is a cheap approximation the QuickEnrich
 * adapter makes deliberately, but declaring a person "inside" because they are
 * in the right country is a different and wrong claim.
 */
import { COUNTRY_CODES, regionCountry } from "./prospectSources/bridge";

export type PlaceVerdict = "inside" | "elsewhere" | "unknown";

/** A city target, with the country it was named beside if it was named. */
interface CityTarget {
  name: string;
  country: string | null;
}

export interface TargetPlaces {
  /** ISO2 codes named as whole countries. */
  countries: string[];
  /** US states / Canadian provinces, with their country. */
  states: { name: string; country: string }[];
  /** Everything narrower or unrecognised, matched by exact name only. */
  cities: CityTarget[];
  /** True when nothing could be read: every verdict is then `unknown`. */
  empty: boolean;
}

const EMPTY_TARGETS: TargetPlaces = { countries: [], states: [], cities: [], empty: true };

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * Classify a campaign's target places once. Cached on the joined list, because
 * the scorer asks per row and the answer depends only on the strings.
 */
const targetCache = new Map<string, TargetPlaces>();

export function parseTargetPlaces(geos: readonly string[] | null | undefined): TargetPlaces {
  const places = (geos ?? []).map((g) => String(g ?? "").trim()).filter(Boolean).slice(0, 24);
  if (places.length === 0) return EMPTY_TARGETS;
  const key = places.map(lower).join("|");
  const hit = targetCache.get(key);
  if (hit) return hit;

  const countries = new Set<string>();
  const states: { name: string; country: string }[] = [];
  const cities: CityTarget[] = [];
  for (const place of places) {
    const n = lower(place);
    const whole = COUNTRY_CODES[n];
    if (whole) { countries.add(whole); continue; }
    const asState = regionCountry(n);
    if (asState) { states.push({ name: n, country: asState }); continue; }
    // "Kentucky, United States" / "Richmond, United States": read the tail as
    // a country and the head as whichever of state or city it turns out to be.
    const comma = n.lastIndexOf(",");
    const tail = comma > 0 ? COUNTRY_CODES[n.slice(comma + 1).trim()] : undefined;
    if (tail) {
      const head = n.slice(0, comma).trim();
      const headState = regionCountry(head);
      if (headState === tail) states.push({ name: head, country: tail });
      else cities.push({ name: head, country: tail });
      continue;
    }
    cities.push({ name: n, country: null });
  }
  const parsed: TargetPlaces = {
    countries: Array.from(countries),
    states,
    cities,
    empty: countries.size === 0 && states.length === 0 && cities.length === 0,
  };
  // Bounded: a workspace has a handful of ICPs, and this is a display/scoring
  // cache, not a correctness one.
  if (targetCache.size > 500) targetCache.clear();
  targetCache.set(key, parsed);
  return parsed;
}

/** Test seam, and for a workspace whose ICP changed mid-process. */
export function _clearTargetPlaceCache(): void {
  targetCache.clear();
}

/**
 * The best place string available for a prospect. The canonical person's
 * structured fields win over the queue row's free text, because
 * `prospect_queue.geography` arrives in eight different shapes depending on
 * which source produced it — a well-formed "city, state, country" from
 * WarmySender and Apollo, a bare city from internal contacts, LLM-extracted
 * prose from the scrapers, and an empty string from internal leads.
 */
export function placeStringOf(row: {
  personCity?: string | null;
  personState?: string | null;
  personCountry?: string | null;
  geography?: string | null;
}): string {
  const structured = [row.personCity, row.personState, row.personCountry].map((s) => String(s ?? "").trim()).filter(Boolean);
  if (structured.length > 0) return structured.join(", ");
  return String(row.geography ?? "").trim();
}

/**
 * Where a person is, against a campaign's places.
 *
 * `inside` on a positive match of country, state or an exactly-named city;
 * `elsewhere` only when their country or state resolves and the targets
 * exclude it; `unknown` for everything else, including every blank place.
 */
export function placeFit(place: string | null | undefined, targets: TargetPlaces): PlaceVerdict {
  // The guard the QuickEnrich check lacks. Nothing targeted means nothing can
  // be outside it.
  if (targets.empty) return "unknown";
  const parts = String(place ?? "").split(",").map(lower).filter(Boolean);
  if (parts.length === 0) return "unknown";

  const country = COUNTRY_CODES[parts[parts.length - 1]] ?? null;
  // A state named anywhere in the string, not only second-to-last: "Virginia,
  // United States" and "Richmond, Virginia, United States" both resolve, and
  // so does a two-part "Ontario, Canada". The first match wins because
  // "Charleston, West Virginia" must read as West Virginia, and scanning left
  // to right reaches the city first — so a city that happens to share a state
  // name is the one case this gets wrong, and it gets it wrong towards the
  // state, which is the coarser and safer of the two.
  let state: { name: string; country: string } | null = null;
  for (const p of parts) {
    const c = regionCountry(p);
    if (c) { state = { name: p, country: c }; break; }
  }

  // ── inside, on positive evidence ──
  if (state && targets.states.some((s) => s.name === state!.name)) return "inside";
  if (country && targets.countries.includes(country)) return "inside";
  if (state && targets.countries.includes(state.country)) return "inside";
  if (targets.cities.some((c) => parts.includes(c.name))) return "inside";

  // ── elsewhere, also on positive evidence ──
  const placeCountry = country ?? state?.country ?? null;
  const targeted = new Set<string>([
    ...targets.countries,
    ...targets.states.map((s) => s.country),
    ...targets.cities.map((c) => c.country).filter((c): c is string => c != null),
  ]);
  /**
   * `targeted.size > 0` is the SECOND form of the trap this module exists to
   * avoid, and a behavioural test caught me reproducing it (2026-10-30). When
   * every target is a bare city — or a broad region name we refuse to resolve,
   * like "Northeast" — no country is known, and without that an empty set
   * would make every resolvable place "elsewhere": a campaign aimed at
   * "Northeast" would have called a Bostonian out-of-territory. A target list
   * that names no country cannot say who is outside it.
   */
  if (placeCountry && targeted.size > 0) {
    // A country nothing targets: unambiguously elsewhere.
    if (!targeted.has(placeCountry)) return "elsewhere";
    // Right country, and the targets name states in it that this is not one
    // of. This is the West Virginia case, and the reason a substring test
    // cannot do this job.
    if (state && targets.states.some((s) => s.country === placeCountry) && !targets.states.some((s) => s.name === state!.name)) {
      return "elsewhere";
    }
  }
  // Right country but city-level targets we cannot confirm, or a place that
  // names neither. Not a guess either way.
  return "unknown";
}
