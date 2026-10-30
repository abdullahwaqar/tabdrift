/**
 * fzf-style matching for the overlay: the fzy scoring algorithm (the one
 * behind Telescope's fzy sorter) plus fzf's extended search syntax.
 *
 *   rust book      both words, fuzzy, in any order
 *   'exact         an exact substring
 *   ^gith          title or address starts with it
 *   .pdf$          title or address ends with it
 *   !jira          leave out anything containing it
 *
 * Lowercase words match any case. A word with a capital letter only matches
 * that exact case (smart case). Pure: no browser APIs, so the background
 * script uses it too.
 */

export interface Candidate<T> {
    item: T;
    /** Usually the page title. */
    title: string;
    /** Usually the address, already shortened with displayUrl(). */
    sub: string;
    /** Hostname without www., for the site-name boost. */
    host?: string;
    /** Also searched, but not shown highlighted: a bookmark's folder, a command's keywords. */
    extra?: string;
    /** Added to the match score: recency, visit count and so on. */
    boost?: number;
}

export interface Ranked<T> {
    item: T;
    score: number;
    /** Matched character positions in `title` and `sub`, for highlighting. */
    titlePos: number[];
    subPos: number[];
}

type TermKind = "fuzzy" | "exact" | "prefix" | "suffix";

export interface Term {
    text: string;
    kind: TermKind;
    negate: boolean;
    caseSensitive: boolean;
}

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
/** Extra for a word that is the whole field, e.g. "docs.rs" typed in full. */
const SCORE_EXACT_FIELD = 1;

/** Long addresses are cut before scoring. The interesting part (site and path) is at the front. */
const MAX_HAYSTACK = 256;
const MAX_NEEDLE = 64;

/** A title match counts a bit more than an address match. */
const TITLE_WEIGHT = 1.0;
const SUB_WEIGHT = 0.9;
const EXTRA_WEIGHT = 0.7;
const SITE_WEIGHT = 0.85;
const HOST_EXACT_LABEL_BONUS = 3.0;
const HOST_PREFIX_BONUS = 2.0;
const HOST_LABEL_BONUS = 1.0;
const WHOLE_HOST_BONUS = 3.0;
const HOST_ABBREV_BONUS = 0.75;

export function parseQuery(query: string): Term[] {
    const terms: Term[] = [];
    for (const raw of query.trim().split(/\s+/)) {
        if (!raw) {
            continue;
        }
        let text = raw;
        let negate = false;
        let kind: TermKind = "fuzzy";

        if (text.startsWith("!") && text.length > 1) {
            negate = true;
            text = text.slice(1);
        }
        if (text.startsWith("'") && text.length > 1) {
            kind = "exact";
            text = text.slice(1);
        } else if (text.startsWith("^") && text.length > 1) {
            kind = "prefix";
            text = text.slice(1);
        } else if (text.endsWith("$") && text.length > 1) {
            kind = "suffix";
            text = text.slice(0, -1);
        }
        // "!foo" on its own means "doesn't contain foo", not a fuzzy "doesn't roughly match".
        if (negate && kind === "fuzzy") {
            kind = "exact";
        }
        if (!text) {
            continue;
        }
        terms.push({ text: text.slice(0, MAX_NEEDLE), kind, negate, caseSensitive: /[A-Z]/.test(text) });
    }
    return terms;
}

/** The words worth handing to a plain substring search (Firefox's history search): no negations or syntax. */
export function plainWords(query: string): string {
    return parseQuery(query)
        .filter((t) => !t.negate)
        .map((t) => t.text)
        .join(" ");
}

let bufD = new Float64Array(0);
let bufM = new Float64Array(0);
let bufBonus = new Float64Array(0);

function ensureBuffers(cells: number, m: number) {
    if (bufD.length < cells) {
        bufD = new Float64Array(cells * 2);
        bufM = new Float64Array(cells * 2);
    }
    if (bufBonus.length < m) {
        bufBonus = new Float64Array(m * 2);
    }
}

function isLower(c: string): boolean {
    return c !== c.toUpperCase() && c === c.toLowerCase();
}
function isUpper(c: string): boolean {
    return c !== c.toLowerCase() && c === c.toUpperCase();
}

function bonusFor(prev: string, cur: string): number {
    if (prev === "/") {
        return SCORE_MATCH_SLASH;
    }
    if (prev === "-" || prev === "_" || prev === " " || prev === ":" || prev === "?" || prev === "=" || prev === "&" || prev === "#") {
        return SCORE_MATCH_WORD;
    }
    if (prev === ".") {
        return SCORE_MATCH_DOT;
    }
    if (isLower(prev) && isUpper(cur)) {
        return SCORE_MATCH_CAPITAL;
    }
    return 0;
}

/** Every needle character appears in order in the haystack. Cheap check before the full scoring. */
function isSubsequence(needle: string, hay: string): boolean {
    let j = 0;
    for (let i = 0; i < needle.length; i++) {
        const at = hay.indexOf(needle[i] as string, j);
        if (at === -1) {
            return false;
        }
        j = at + 1;
    }
    return true;
}

export interface FuzzyHit {
    score: number;
    positions: number[];
}

/**
 * Scores `needle` against `haystack` and returns where it matched, or null if
 * it doesn't match at all. Consecutive characters and characters right after
 * a separator (/, ., -, space) or at a camelCase hump score highest.
 */
export function fuzzy(needle: string, haystack: string, caseSensitive = false, strict = true): FuzzyHit | null {
    const original = haystack.length > MAX_HAYSTACK ? haystack.slice(0, MAX_HAYSTACK) : haystack;
    const n = needle.length;
    const m = original.length;
    if (n === 0 || n > m) {
        return null;
    }
    const nd = caseSensitive ? needle : needle.toLowerCase();
    const hs = caseSensitive ? original : original.toLowerCase();
    if (!isSubsequence(nd, hs)) {
        return null;
    }
    if (n === m) {
        // The whole field: as good as one unbroken run, plus a little for being complete.
        return { score: (n - 1) * SCORE_MATCH_CONSECUTIVE + SCORE_MATCH_SLASH + SCORE_EXACT_FIELD, positions: Array.from({ length: n }, (_, i) => i) };
    }

    ensureBuffers(n * m, m);
    const D = bufD;
    const M = bufM;
    const bonus = bufBonus;

    let prev = "/";
    for (let j = 0; j < m; j++) {
        const cur = original[j] as string;
        bonus[j] = bonusFor(prev, cur);
        prev = cur;
    }

    for (let i = 0; i < n; i++) {
        let prevScore = Number.NEGATIVE_INFINITY;
        const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
        const row = i * m;
        const prow = (i - 1) * m;
        const nc = nd[i];
        for (let j = 0; j < m; j++) {
            if (nc === hs[j]) {
                let score = Number.NEGATIVE_INFINITY;
                if (i === 0) {
                    score = j * SCORE_GAP_LEADING + (bonus[j] as number);
                } else if (j > 0) {
                    score = Math.max((M[prow + j - 1] as number) + (bonus[j] as number), (D[prow + j - 1] as number) + SCORE_MATCH_CONSECUTIVE);
                }
                D[row + j] = score;
                prevScore = Math.max(score, prevScore + gap);
                M[row + j] = prevScore;
            } else {
                D[row + j] = Number.NEGATIVE_INFINITY;
                prevScore = prevScore + gap;
                M[row + j] = prevScore;
            }
        }
    }

    const score = M[(n - 1) * m + m - 1] as number;
    if (!Number.isFinite(score)) {
        return null;
    }
    const positions = backtrack(D, M, n, m);
    if (strict && tooScattered(positions, bonus, n)) {
        return null;
    }
    return { score, positions };
}

/**
 * fzy matches any subsequence, so "rust" finds "Pull requests" (r, u, st).
 * A match that breaks into pieces is kept only if most pieces start a word:
 * "ghtd" for "GitHub ... tabdrift" stays, "rust" in "requests" goes.
 */
function tooScattered(positions: number[], bonus: Float64Array, n: number): boolean {
    let chunks = 0;
    let penalty = 0;
    for (let i = 0; i < positions.length; i++) {
        const p = positions[i] as number;
        if (i > 0 && p === (positions[i - 1] as number) + 1) {
            continue;
        }
        chunks++;
        if (p > 0 && (bonus[p] as number) === 0) {
            // A lone letter in the middle of a word ("docs" in "doc.ru[s]t") is the weakest evidence of all.
            const lone = positions[i + 1] !== p + 1;
            penalty += lone ? 2 : 1;
        }
    }
    return chunks > 1 && penalty > Math.floor(n / 3);
}

/** Walks back through the score tables to find which characters made the best score. */
function backtrack(D: Float64Array, M: Float64Array, n: number, m: number): number[] {
    // Walk back through the table to find which characters made the best score.
    const positions = new Array<number>(n);
    let matchRequired = false;
    let j = m - 1;
    for (let i = n - 1; i >= 0; i--) {
        const row = i * m;
        for (; j >= 0; j--) {
            const d = D[row + j] as number;
            if (d !== Number.NEGATIVE_INFINITY && (matchRequired || d === M[row + j])) {
                matchRequired = i > 0 && j > 0 && M[row + j] === (D[(i - 1) * m + j - 1] as number) + SCORE_MATCH_CONSECUTIVE;
                positions[i] = j;
                j--;
                break;
            }
        }
    }
    return positions;
}

function range(start: number, length: number): number[] {
    return Array.from({ length }, (_, i) => start + i);
}

function fold(text: string, caseSensitive: boolean): string {
    return caseSensitive ? text : text.toLowerCase();
}

/** Word-start bonus for a literal match at `at`. */
function startBonus(text: string, at: number): number {
    return at === 0 ? SCORE_MATCH_SLASH : bonusFor(text[at - 1] as string, text[at] as string);
}

interface FieldHit {
    score: number;
    field: "title" | "sub" | "extra";
    positions: number[];
}

function literalHit(term: Term, title: string, sub: string, extra = ""): FieldHit | null {
    const needle = fold(term.text, term.caseSensitive);
    let best: FieldHit | null = null;
    for (const [field, raw, weight] of [
        ["title", title, TITLE_WEIGHT],
        ["sub", sub, SUB_WEIGHT],
        ["extra", extra, EXTRA_WEIGHT],
    ] as const) {
        const hay = fold(raw, term.caseSensitive);
        let at = -1;
        if (term.kind === "exact") {
            at = hay.indexOf(needle);
        } else if (term.kind === "prefix") {
            at = hay.startsWith(needle) ? 0 : -1;
        } else if (term.kind === "suffix") {
            at = hay.endsWith(needle) ? hay.length - needle.length : -1;
        }
        if (at === -1) {
            continue;
        }
        const score = ((needle.length - 1) * SCORE_MATCH_CONSECUTIVE + startBonus(raw, at) + 1) * weight;
        if (!best || score > best.score) {
            best = { score, field, positions: range(at, needle.length) };
        }
    }
    return best;
}

function fuzzyHit(term: Term, title: string, sub: string, extra = "", site = ""): FieldHit | null {
    let best: FieldHit | null = null;
    for (const [field, raw, weight, strict] of [
        ["title", title, TITLE_WEIGHT, true],
        ["sub", sub, SUB_WEIGHT, true],
        ["extra", extra, EXTRA_WEIGHT, true],
        // Site names are short and typed on purpose, so loose abbreviations are fine there ("gh", "gcal").
        ["extra", site, SITE_WEIGHT, false],
    ] as const) {
        const hit = raw ? fuzzy(term.text, raw, term.caseSensitive, strict) : null;
        if (hit && (!best || hit.score * weight > best.score)) {
            best = { score: hit.score * weight, field, positions: hit.positions };
        }
    }
    return best;
}

// Endings that say nothing about which site it is.
const GENERIC_LABELS = new Set(["www", "com", "org", "net", "co", "ac", "gov", "edu", "io", "app", "dev"]);

/** The parts of a hostname that name the site, most general first: "calendar.google.com" -> ["google", "calendar"]. */
export function siteLabels(host: string | undefined): string[] {
    if (!host) {
        return [];
    }
    const labels = host.split(":")[0]?.split(".") ?? [];
    if (labels.length > 1) {
        labels.pop();
    }
    return labels.filter((l, i) => l && !(GENERIC_LABELS.has(l) && labels.length > 1 && i === labels.length - 1) && l !== "www").reverse();
}

/** How strongly one word points at the site itself: a whole label beats the start of one. */
function labelScore(term: Term, host: string, labels: string[]): number {
    if (term.negate || term.kind === "suffix") {
        return 0;
    }
    const needle = term.text.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!needle) {
        return 0;
    }
    if (labels.includes(needle)) {
        return HOST_EXACT_LABEL_BONUS;
    }
    if (host.startsWith(needle)) {
        return HOST_PREFIX_BONUS;
    }
    // "search.google" typed as one word: every dotted part names a label.
    if (needle.includes(".") && needle.split(".").every((part) => part && labels.some((l) => l.startsWith(part)))) {
        return HOST_PREFIX_BONUS;
    }
    if (labels.some((label) => label.startsWith(needle))) {
        return HOST_LABEL_BONUS;
    }
    // An abbreviation of one label: "gh" for github, "yt" for youtube.
    return needle.length > 1 && labels.some((label) => label[0] === needle[0] && isSubsequence(needle, label)) ? HOST_ABBREV_BONUS : 0;
}

function scoreCandidate<T>(cand: Candidate<T>, terms: Term[]): Ranked<T> | null {
    const host = cand.host ?? "";
    const labels = siteLabels(host);
    // "google calendar" for calendar.google.com, so words can come in either order and "gcal" works.
    const site = labels.join(" ");
    let hostTerms = 0;
    let positive = 0;
    let total = 0;
    const titlePos: number[] = [];
    const subPos: number[] = [];
    for (const term of terms) {
        if (term.negate) {
            if (literalHit(term, cand.title, cand.sub, cand.extra)) {
                return null;
            }
            continue;
        }
        const hit = term.kind === "fuzzy" ? fuzzyHit(term, cand.title, cand.sub, cand.extra, site) : literalHit(term, cand.title, cand.sub, cand.extra);
        if (!hit) {
            return null;
        }
        const onHost = host ? labelScore(term, host, labels) : 0;
        if (onHost > 0) {
            hostTerms++;
        }
        positive++;
        total += hit.score + onHost;
        if (hit.field === "title") {
            titlePos.push(...hit.positions);
        } else if (hit.field === "sub") {
            subPos.push(...hit.positions);
        }
    }
    // Every word named part of the site ("search google" for search.google.com): that's the site you meant.
    if (positive > 1 && hostTerms === positive) {
        total += WHOLE_HOST_BONUS;
    }
    return { item: cand.item, score: total + (cand.boost ?? 0), titlePos, subPos };
}

/**
 * Filters and sorts candidates for a query, best first. Every word has to
 * match the title or the address. An empty query matches nothing; callers
 * decide what to show before anything is typed.
 */
export function rank<T>(candidates: Candidate<T>[], query: string, limit = Number.POSITIVE_INFINITY): Ranked<T>[] {
    const terms = parseQuery(query);
    if (terms.length === 0 || terms.every((t) => t.negate)) {
        // Only exclusions: keep everything that doesn't hit one, in the order given.
        if (terms.length === 0) {
            return [];
        }
        return candidates
            .map((c) => scoreCandidate(c, terms))
            .filter((r): r is Ranked<T> => r !== null)
            .slice(0, limit);
    }
    const out: Ranked<T>[] = [];
    for (const cand of candidates) {
        const r = scoreCandidate(cand, terms);
        if (r) {
            out.push(r);
        }
    }
    // Stable sort, so ties keep the order the caller gave (usually most recent first).
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
}

/** "https://www.github.com/foo/" -> "github.com/foo". What rows show and what addresses are matched against. */
export function displayUrl(url: string | undefined): string {
    if (!url) {
        return "";
    }
    return url
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/$/, "");
}

/** Hostname without www., or "" for addresses that aren't web pages. */
export function hostOf(url: string | undefined): string {
    if (!url) {
        return "";
    }
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
        return "";
    }
}

/** Small bonus for things used recently, so ties go to what you were just looking at. */
export function recencyBoost(timestamp: number | undefined, now = Date.now()): number {
    if (!timestamp) {
        return 0;
    }
    const hours = Math.max(0, now - timestamp) / 3_600_000;
    // 0.6 for just now, about 0.15 after a day, under 0.1 after a few weeks.
    return 0.6 / (1 + Math.log1p(hours));
}

/** History ranking: places you go often and went to lately win ties. Shared by the background and the overlay. */
export function historyBoost(lastVisitTime: number | undefined, visitCount: number | undefined, now = Date.now()): number {
    return recencyBoost(lastVisitTime, now) * 0.5 + Math.log1p(visitCount ?? 0) * 0.12;
}
