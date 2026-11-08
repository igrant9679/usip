/**
 * A page's view in its address (audit 2026-10-20, U6): filters, sort, page,
 * tab and the record that is open live in the query string, so a refresh
 * keeps the view and a copied link opens the same one for someone else.
 *
 *   const [page, setPage] = useUrlState("page", urlParam.int(1));
 *   const [tiers, setTiers] = useUrlState("tier", urlParam.set());
 *
 * The address is the only copy: the hook reads the value from it on every
 * render and the setter writes it back with a replace (no history entry per
 * keystroke or click; Back still leaves the page). A value equal to its
 * default is left out, so an untouched page keeps a clean address. Other
 * parameters are kept as they are, so links that already work (`?q=`,
 * `?reply=`, `?tab=`, `?prospect=`) keep working beside these.
 *
 * Setters read the address at the moment they run, not the render's copy, so
 * several in one handler (a saved view applying ten filters) all land.
 *
 * readParam / writeParam are pure, for tests.
 */
import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

export type UrlParam<T> = {
  /** The value for a raw query value (null when the key is absent). */
  parse: (raw: string | null) => T;
  /** The raw query value, or null to leave the key out (the default). */
  format: (value: T) => string | null;
};

const LIST_SEP = ",";

export const urlParam = {
  /** Free text; "" is the default and is left out. */
  string(def = ""): UrlParam<string> {
    return { parse: (r) => (r ?? def), format: (v) => (v === def || v === "" ? null : v) };
  },
  /** A whole number at least `min`; anything else reads as the default. */
  int(def: number, min = 1): UrlParam<number> {
    return {
      parse: (r) => { const n = Number(r); return r != null && Number.isInteger(n) && n >= min ? n : def; },
      format: (v) => (v === def ? null : String(v)),
    };
  },
  /** A record id: a positive whole number, or null when none is open. */
  id(): UrlParam<number | null> {
    return {
      parse: (r) => { const n = Number(r); return r != null && Number.isInteger(n) && n > 0 ? n : null; },
      format: (v) => (v == null ? null : String(v)),
    };
  },
  /** On when the key is "1"; off is the default and is left out. */
  bool(): UrlParam<boolean> {
    return { parse: (r) => r === "1", format: (v) => (v ? "1" : null) };
  },
  /** One of a fixed set; anything else reads as the default. */
  oneOf<T extends string>(values: readonly T[], def: T): UrlParam<T> {
    return {
      parse: (r) => ((values as readonly string[]).includes(r ?? "") ? (r as T) : def),
      format: (v) => (v === def ? null : v),
    };
  },
  /** A set of strings, comma-separated; empty is the default. */
  set(): UrlParam<Set<string>> {
    return {
      parse: (r) => new Set((r ?? "").split(LIST_SEP).map((s) => s.trim()).filter(Boolean)),
      format: (v) => (v.size ? Array.from(v).join(LIST_SEP) : null),
    };
  },
};

/** The value of `key` in a query string ("?a=1&b=2" or "a=1&b=2"). */
export function readParam<T>(search: string, key: string, p: UrlParam<T>): T {
  return p.parse(new URLSearchParams(search.replace(/^\?/, "")).get(key));
}

/** The query string with `key` set to `value`, or without it at the default; "" or "?…". */
export function writeParam<T>(search: string, key: string, value: T, p: UrlParam<T>): string {
  const sp = new URLSearchParams(search.replace(/^\?/, ""));
  const raw = p.format(value);
  if (raw == null) sp.delete(key);
  else sp.set(key, raw);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** Whether any of `keys` is in the query string (a deep link, or a shared view). */
export function hasAnyParam(search: string, keys: readonly string[]): boolean {
  const sp = new URLSearchParams(search.replace(/^\?/, ""));
  return keys.some((k) => sp.has(k));
}

type SetState<T> = (next: T | ((prev: T) => T)) => void;

/** State kept in the address under `key`: `[value, setValue]`, like useState. */
export function useUrlState<T>(key: string, p: UrlParam<T>): [T, SetState<T>] {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get(key);
  // Parsed once per raw value, so a set or an object keeps its identity until
  // this key itself changes, not whenever another parameter does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => p.parse(raw), [raw]);
  const set = useCallback<SetState<T>>((next) => {
    const current = typeof window === "undefined" ? "" : window.location.search;
    const prev = readParam(current, key, p);
    const v = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
    const qs = writeParam(current, key, v, p);
    if (qs === (current === "?" ? "" : current)) return;
    navigate(`${window.location.pathname}${qs}${window.location.hash}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, navigate]);
  return [value, set];
}
