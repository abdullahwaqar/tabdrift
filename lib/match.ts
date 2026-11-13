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
/**
 * Cost per scattered piece of a match (see scatterPenalty). Loose matches like "gmal" for Gmail
 * still show up, they just rank under clean ones.
 */
const SCORE_SCATTER = 0.5;

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

/**
 * One searchable string, with everything that doesn't depend on the query
 * worked out once: the lowercase copy, the part fuzzy scoring looks at, and
 * a bitmask of which letters and digits it contains.
 */
interface Field {
    /** The whole string, for exact, prefix and suffix words. */
    raw: string;
    low: string;
    /** The first MAX_HAYSTACK characters, for fuzzy scoring. */
    fz: string;
    fzLow: string;
    /** One bit per letter a-z, plus one for any digit. */
    mask: number;
}

/** A candidate ready for fast repeated ranking. Build with prepare() and reuse across keystrokes. */
export interface Prepared<T> {
    item: T;
    title: Field;
    sub: Field;
    extra: Field;
    site: Field;
    host: string;
    labels: string[];
    /** Every field's mask together: a word whose letters aren't all here can't match. */
    mask: number;
    boost: number;
}

const DIGIT_BIT = 1 << 26;

function maskOf(low: string): number {
    let mask = 0;
    for (let i = 0; i < low.length; i++) {
        const c = low.charCodeAt(i);
        if (c >= 97 && c <= 122) {
            mask |= 1 << (c - 97);
        } else if (c >= 48 && c <= 57) {
            mask |= DIGIT_BIT;
        }
    }
    return mask;
}

const EMPTY_FIELD: Field = { raw: "", low: "", fz: "", fzLow: "", mask: 0 };

function field(raw: string | undefined): Field {
    if (!raw) {
        return EMPTY_FIELD;
    }
    const low = raw.toLowerCase();
    const fz = raw.length > MAX_HAYSTACK ? raw.slice(0, MAX_HAYSTACK) : raw;
    const fzLow = fz === raw ? low : fz.toLowerCase();
    return { raw, low, fz, fzLow, mask: maskOf(low) };
}

/** Does the slow, query-independent work for a candidate once, so each keystroke only scores. */
export function prepare<T>(cand: Candidate<T>): Prepared<T> {
    const host = cand.host ?? "";
    const labels = siteLabels(host);
    const title = field(cand.title);
    const sub = field(cand.sub);
    const extra = field(cand.extra);
    // "google calendar" for calendar.google.com, so words can come in either order and "gcal" works.
    const site = field(labels.join(" "));
    return {
        item: cand.item,
        title,
        sub,
        extra,
        site,
        host,
        labels,
        mask: title.mask | sub.mask | extra.mask | site.mask,
        boost: cand.boost ?? 0,
    };
}

// Scratch space shared by every call, so scoring allocates nothing per candidate.
let bufD = new Float64Array(0);
let bufM = new Float64Array(0);

function ensureBuffers(cells: number) {
    if (bufD.length < cells) {
        bufD = new Float64Array(cells * 2);
        bufM = new Float64Array(cells * 2);
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

/**
 * bonusFor() for the character at `j`, worked out only where a match lands.
 * Plain ASCII, by far the usual case, skips the string case conversions.
 */
function bonusAt(text: string, j: number): number {
    if (j === 0) {
        return SCORE_MATCH_SLASH;
    }
    const p = text.charCodeAt(j - 1);
    const c = text.charCodeAt(j);
    if (p < 128 && c < 128) {
        if (p === 47) {
            return SCORE_MATCH_SLASH;
        }
        // - _ space : ? = & #
        if (p === 45 || p === 95 || p === 32 || p === 58 || p === 63 || p === 61 || p === 38 || p === 35) {
            return SCORE_MATCH_WORD;
        }
        if (p === 46) {
            return SCORE_MATCH_DOT;
        }
        return p >= 97 && p <= 122 && c >= 65 && c <= 90 ? SCORE_MATCH_CAPITAL : 0;
    }
    return bonusFor(text[j - 1] as string, text[j] as string);
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
    return fuzzyField(caseSensitive ? needle : needle.toLowerCase(), field(haystack), caseSensitive, strict);
}

/** fuzzy() on a prepared field. `nd` is already folded to match `caseSensitive`. */
function fuzzyField(nd: string, f: Field, caseSensitive: boolean, strict: boolean): FuzzyHit | null {
    const n = nd.length;
    const m = f.fz.length;
    if (n === 0 || n > m) {
        return null;
    }
    const hs = caseSensitive ? f.fz : f.fzLow;
    if (!isSubsequence(nd, hs)) {
        return null;
    }
    if (n === m) {
        // The whole field: as good as one unbroken run, plus a little for being complete.
        return { score: (n - 1) * SCORE_MATCH_CONSECUTIVE + SCORE_MATCH_SLASH + SCORE_EXACT_FIELD, positions: Array.from({ length: n }, (_, i) => i) };
    }

    // Only columns from the first possible start to the last possible end can be on a match.
    let lo = 0;
    let hi = m - 1;
    if (hs.length === m) {
        lo = hs.indexOf(nd[0] as string);
        hi = hs.lastIndexOf(nd[n - 1] as string);
    }
    const w = hi - lo + 1;
    ensureBuffers(n * w);
    const D = bufD;
    const M = bufM;
    const NEG = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < n; i++) {
        let prevScore = NEG;
        const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
        const row = i * w;
        const prow = row - w;
        const nc = nd[i];
        for (let k = 0; k < w; k++) {
            const j = lo + k;
            if (nc === hs[j]) {
                let score = NEG;
                if (i === 0) {
                    score = j * SCORE_GAP_LEADING + bonusAt(f.fz, j);
                } else if (k > 0) {
                    const a = (M[prow + k - 1] as number) + bonusAt(f.fz, j);
                    const b = (D[prow + k - 1] as number) + SCORE_MATCH_CONSECUTIVE;
                    score = a > b ? a : b;
                }
                D[row + k] = score;
                const carried = prevScore + gap;
                prevScore = score > carried ? score : carried;
                M[row + k] = prevScore;
            } else {
                D[row + k] = NEG;
                prevScore = prevScore + gap;
                M[row + k] = prevScore;
            }
        }
    }

    // Columns after `hi` hold no match, so the last row just keeps paying the trailing gap.
    let score = M[(n - 1) * w + w - 1] as number;
    for (let j = hi + 1; j < m; j++) {
        score += SCORE_GAP_TRAILING;
    }
    if (!Number.isFinite(score)) {
        return null;
    }
    const positions = backtrack(D, M, n, w, lo);
    if (!strict) {
        return { score, positions };
    }
    const penalty = scatterPenalty(positions, f.fz);
    if (penalty > Math.ceil(n * 0.75)) {
        return null;
    }
    return { score: score - penalty * SCORE_SCATTER, positions };
}

/**
 * fzy matches any subsequence, so on its own "rust" finds "Pull requests" (r, u, st) as readily as
 * "The Rust Book". Pieces of a match that start in the middle of a word count against it, a lone
 * letter there most of all. Abbreviations that drop vowels ("gmal", "linkdn", "wthr") stay in the
 * list at a lower score. Only matches that are mostly stray letters are dropped.
 */
function scatterPenalty(positions: number[], text: string): number {
    let chunks = 0;
    let penalty = 0;
    for (let i = 0; i < positions.length; i++) {
        const p = positions[i] as number;
        if (i > 0 && p === (positions[i - 1] as number) + 1) {
            continue;
        }
        chunks++;
        if (p > 0 && bonusAt(text, p) === 0) {
            // A lone letter in the middle of a word ("docs" in "doc.ru[s]t") is the weakest evidence of all.
            const lone = positions[i + 1] !== p + 1;
            penalty += lone ? 2 : 1;
        }
    }
    return chunks > 1 ? penalty : 0;
}

/** Walks back through the score tables (columns lo..lo+w-1) to find which characters made the best score. */
function backtrack(D: Float64Array, M: Float64Array, n: number, w: number, lo: number): number[] {
    const positions = new Array<number>(n);
    let matchRequired = false;
    let k = w - 1;
    for (let i = n - 1; i >= 0; i--) {
        const row = i * w;
        for (; k >= 0; k--) {
            const d = D[row + k] as number;
            if (d !== Number.NEGATIVE_INFINITY && (matchRequired || d === M[row + k])) {
                matchRequired = i > 0 && k > 0 && M[row + k] === (D[row - w + k - 1] as number) + SCORE_MATCH_CONSECUTIVE;
                positions[i] = lo + k;
                k--;
                break;
            }
        }
    }
    return positions;
}

function range(start: number, length: number): number[] {
    return Array.from({ length }, (_, i) => start + i);
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

/** A query word with the per-query work done up front. */
interface PreparedTerm extends Term {
    /** The text folded the way the haystack will be (lowercase unless smart case kicked in). */
    folded: string;
    mask: number;
    /** For the site-name boost: lowercase, without leading or trailing dots. */
    hostNeedle: string;
    hostParts: string[];
}

function prepareTerms(terms: Term[]): PreparedTerm[] {
    return terms.map((t) => {
        const lower = t.text.toLowerCase();
        const hostNeedle = lower.replace(/^\.+|\.+$/g, "");
        return {
            ...t,
            folded: t.caseSensitive ? t.text : lower,
            mask: maskOf(lower),
            hostNeedle,
            hostParts: hostNeedle.includes(".") ? hostNeedle.split(".") : [],
        };
    });
}

function literalIn(term: PreparedTerm, f: Field): number {
    const hay = term.caseSensitive ? f.raw : f.low;
    const needle = term.folded;
    if (term.kind === "exact") {
        return hay.indexOf(needle);
    }
    if (term.kind === "prefix") {
        return hay.startsWith(needle) ? 0 : -1;
    }
    if (term.kind === "suffix") {
        return hay.endsWith(needle) ? hay.length - needle.length : -1;
    }
    return -1;
}

const LITERAL_FIELDS = [
    ["title", TITLE_WEIGHT],
    ["sub", SUB_WEIGHT],
    ["extra", EXTRA_WEIGHT],
] as const;

function literalHit<T>(term: PreparedTerm, cand: Prepared<T>): FieldHit | null {
    let best: FieldHit | null = null;
    for (const [name, weight] of LITERAL_FIELDS) {
        const f = cand[name];
        if ((term.mask & f.mask) !== term.mask) {
            continue;
        }
        const at = literalIn(term, f);
        if (at === -1) {
            continue;
        }
        const score = ((term.folded.length - 1) * SCORE_MATCH_CONSECUTIVE + startBonus(f.raw, at) + 1) * weight;
        if (!best || score > best.score) {
            best = { score, field: name, positions: range(at, term.folded.length) };
        }
    }
    return best;
}

function fuzzyHit<T>(term: PreparedTerm, cand: Prepared<T>): FieldHit | null {
    let best = fieldHit(term, cand.title, "title", TITLE_WEIGHT, true, null);
    best = fieldHit(term, cand.sub, "sub", SUB_WEIGHT, true, best);
    best = fieldHit(term, cand.extra, "extra", EXTRA_WEIGHT, true, best);
    // Site names are short and typed on purpose, so loose abbreviations are fine there ("gh", "gcal").
    return fieldHit(term, cand.site, "extra", SITE_WEIGHT, false, best);
}

/** Scores one field and returns whichever of it and `best` is better. */
function fieldHit(term: PreparedTerm, f: Field, name: FieldHit["field"], weight: number, strict: boolean, best: FieldHit | null): FieldHit | null {
    if (!f.raw || (term.mask & f.mask) !== term.mask) {
        return best;
    }
    const hit = fuzzyField(term.folded, f, term.caseSensitive, strict);
    if (hit && (!best || hit.score * weight > best.score)) {
        return { score: hit.score * weight, field: name, positions: hit.positions };
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
function labelScore(term: PreparedTerm, host: string, labels: string[]): number {
    if (term.negate || term.kind === "suffix") {
        return 0;
    }
    const needle = term.hostNeedle;
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
    if (term.hostParts.length > 0 && term.hostParts.every((part) => part && labels.some((l) => l.startsWith(part)))) {
        return HOST_PREFIX_BONUS;
    }
    if (labels.some((label) => label.startsWith(needle))) {
        return HOST_LABEL_BONUS;
    }
    // An abbreviation of one label: "gh" for github, "yt" for youtube.
    return needle.length > 1 && labels.some((label) => label[0] === needle[0] && isSubsequence(needle, label)) ? HOST_ABBREV_BONUS : 0;
}

function scoreCandidate<T>(cand: Prepared<T>, terms: PreparedTerm[]): Ranked<T> | null {
    const host = cand.host;
    let hostTerms = 0;
    let positive = 0;
    let total = 0;
    let titlePos: number[] | null = null;
    let subPos: number[] | null = null;
    for (const term of terms) {
        if (term.negate) {
            if ((term.mask & cand.mask) === term.mask && literalHit(term, cand)) {
                return null;
            }
            continue;
        }
        if ((term.mask & cand.mask) !== term.mask) {
            // A letter of this word appears nowhere in the candidate.
            return null;
        }
        const hit = term.kind === "fuzzy" ? fuzzyHit(term, cand) : literalHit(term, cand);
        if (!hit) {
            return null;
        }
        const onHost = host ? labelScore(term, host, cand.labels) : 0;
        if (onHost > 0) {
            hostTerms++;
        }
        positive++;
        total += hit.score + onHost;
        if (hit.field === "title") {
            titlePos = titlePos ? titlePos.concat(hit.positions) : hit.positions;
        } else if (hit.field === "sub") {
            subPos = subPos ? subPos.concat(hit.positions) : hit.positions;
        }
    }
    // Every word named part of the site ("search google" for search.google.com): that's the site you meant.
    if (positive > 1 && hostTerms === positive) {
        total += WHOLE_HOST_BONUS;
    }
    return { item: cand.item, score: total + cand.boost, titlePos: titlePos ?? [], subPos: subPos ?? [] };
}

/**
 * Filters and sorts candidates for a query, best first. Every word has to
 * match the title or the address. An empty query matches nothing; callers
 * decide what to show before anything is typed.
 */
export function rank<T>(candidates: Candidate<T>[], query: string, limit = Number.POSITIVE_INFINITY): Ranked<T>[] {
    if (parseQuery(query).length === 0) {
        return [];
    }
    return rankPrepared(candidates.map(prepare), query, limit);
}

/** rank() for candidates already run through prepare(). Keep the prepared list around and reuse it. */
export function rankPrepared<T>(candidates: readonly Prepared<T>[], query: string, limit = Number.POSITIVE_INFINITY): Ranked<T>[] {
    const terms = prepareTerms(parseQuery(query));
    if (terms.length === 0) {
        return [];
    }
    const out: Ranked<T>[] = [];
    if (terms.every((t) => t.negate)) {
        // Only exclusions: keep everything that doesn't hit one, in the order given.
        for (const cand of candidates) {
            const r = scoreCandidate(cand, terms);
            if (r) {
                out.push(r);
                if (out.length >= limit) {
                    break;
                }
            }
        }
        return out;
    }
    for (const cand of candidates) {
        const r = scoreCandidate(cand, terms);
        if (r) {
            out.push(r);
        }
    }
    // Stable sort, so ties keep the order the caller gave (usually most recent first).
    out.sort((a, b) => b.score - a.score);
    return out.length > limit ? out.slice(0, limit) : out;
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
