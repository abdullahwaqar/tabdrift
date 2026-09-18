/**
 * Email and URL helpers behind the overlay's "Utilities" rows, the
 * "copy clean link" shortcut and the right-click menu.
 *
 * Everything in here is pure: no browser APIs, no network. That keeps it
 * easy to reason about and easy to test.
 */

export interface UtilAction {
    id: string;
    /** Short description shown under the value, e.g. "Domain". */
    label: string;
    /** What gets copied (or opened, for `open` actions). */
    value: string;
    /** What the row shows instead of `value`, when the value is long or multi-line. */
    display?: string;
    action: "copy" | "open";
}

export interface CleanResult {
    url: string;
    /** Names of the query parameters that were dropped. */
    removed: string[];
}

interface TabLike {
    url?: string;
    title?: string;
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                    */
/* -------------------------------------------------------------------------- */

// Second-level labels that sit in front of a 2-letter country TLD (co.uk, com.au, co.ae ...).
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "sch", "ltd", "plc", "me", "info", "biz"]);

/**
 * Best-effort registrable domain: "mail.acme.co.uk" -> "acme.co.uk".
 * A real answer needs the Public Suffix List; this heuristic covers the
 * common country-code patterns without shipping a 200 KB list.
 */
export function rootDomain(host: string): string {
    const labels = host.toLowerCase().split(".");
    if (labels.length <= 2 || labels.every((l) => /^\d+$/.test(l))) {
        return host.toLowerCase();
    }
    const tld = labels[labels.length - 1] ?? "";
    const sld = labels[labels.length - 2] ?? "";
    if (tld.length === 2 && SECOND_LEVEL_LABELS.has(sld)) {
        return labels.slice(-3).join(".");
    }
    return labels.slice(-2).join(".");
}

function stripWww(host: string): string {
    return host.replace(/^www\./i, "");
}

/* -------------------------------------------------------------------------- */
/* Emails                                                                     */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i;

/**
 * Returns the email addresses in `text` if the whole text is nothing but
 * email addresses (one or many, separated by spaces, commas, semicolons or
 * new lines; "Name <a@b.com>" and "mailto:a@b.com" are fine too).
 * Returns null for anything else, so ordinary searches like
 * "invoice john@acme.com" are left alone.
 */
export function parseEmails(text: string): string[] | null {
    const trimmed = text.trim();
    if (!trimmed.includes("@")) {
        return null;
    }

    // "John Doe <john@acme.com>" -> "john@acme.com"
    const flattened = trimmed.replace(/[^<>,;\n]*<([^<>\s]+)>/g, "$1 ");

    const emails: string[] = [];
    for (const token of flattened.split(/[\s,;]+/)) {
        if (!token) {
            continue;
        }
        const cleaned = token
            .replace(/^mailto:/i, "")
            .replace(/^[<"'([]+/, "")
            .replace(/[>"')\].]+$/, "");
        if (!EMAIL_RE.test(cleaned)) {
            return null;
        }
        emails.push(cleaned);
    }
    return emails.length > 0 ? emails : null;
}

export function emailDomain(email: string): string {
    return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* URL cleaning                                                               */
/* -------------------------------------------------------------------------- */

// Query parameters that only exist to track you. Kept conservative on purpose:
// anything generic enough to break a real page ("ref", "source", "s", "t", "id")
// is left out of the global list and only handled per site below.
const TRACKING_PARAMS = new Set([
    // Google
    "gclid",
    "gclsrc",
    "dclid",
    "gbraid",
    "wbraid",
    "gad_source",
    "gad_campaignid",
    "srsltid",
    "_ga",
    "_gl",
    "_gac",
    // Meta / social click ids
    "fbclid",
    "mibextid",
    "igshid",
    "igsh",
    "twclid",
    "ttclid",
    "li_fat_id",
    "sclid",
    "epik",
    "rdt_cid",
    "ref_src",
    "ref_url",
    // Microsoft / other ad networks
    "msclkid",
    "yclid",
    "ymclid",
    "irclickid",
    "irgwc",
    "rb_clickid",
    "wickedid",
    "ranmid",
    "raneaid",
    "ransiteid",
    // Email marketing platforms
    "mc_cid",
    "mc_eid",
    "mkt_tok",
    "_hsenc",
    "_hsmi",
    "__s",
    "_kx",
    "ck_subscriber_id",
    "vero_id",
    "vero_conv",
    "oly_anon_id",
    "oly_enc_id",
    "trk_contact",
    "trk_msg",
    "trk_module",
    "trk_sid",
    // Misc campaign tags
    "icid",
    "ocid",
    "cmpid",
    "s_cid",
    "scid",
    "spm",
    "smid",
    "smtyp",
    "trk",
    "trkinfo",
    "trackingid",
    "refid",
    "ss_source",
    "ss_campaign_id",
]);

const TRACKING_PREFIXES = ["utm_", "hsa_", "mtm_", "pk_", "piwik_", "matomo_", "pf_rd_", "pd_rd_", "__hs", "_hs"];

interface SiteRule {
    host: RegExp;
    /** Only apply to paths matching this. */
    path?: RegExp;
    /** Extra parameters to drop on this site (lower-case). */
    drop?: string[];
    /** Drop the whole query string. */
    dropAll?: boolean;
}

const SITE_RULES: SiteRule[] = [
    { host: /(^|\.)youtube\.com$|^youtu\.be$/, drop: ["si", "feature", "pp", "ab_channel", "app", "embeds_referring_euri", "source_ve_path"] },
    { host: /^open\.spotify\.com$/, drop: ["si", "context", "nd", "dlsi", "pi"] },
    {
        host: /^(www\.)?google\.[a-z.]+$/,
        path: /^\/search/,
        drop: [
            "sca_esv",
            "ei",
            "ved",
            "uact",
            "sxsrf",
            "sclient",
            "source",
            "oq",
            "gs_lcp",
            "gs_lp",
            "client",
            "bih",
            "biw",
            "dpr",
            "iflsig",
            "fbs",
            "gs_ssp",
            "sourceid",
            "rlz",
            "aqs",
            "ie",
            "oe",
        ],
    },
    { host: /(^|\.)amazon\.[a-z.]+$/, drop: ["tag", "linkcode", "ref_", "ref", "qid", "sr", "crid", "sprefix", "dib", "dib_tag", "_encoding", "content-id"] },
    { host: /(^|\.)reddit\.com$/, drop: ["context", "share_id", "rdt", "ref_source", "ref_campaign", "correlation_id"] },
    { host: /(^|\.)medium\.com$/, drop: ["source", "sk", "gi"] },
    { host: /(^|\.)(twitter|x)\.com$/, path: /\/status\//, dropAll: true },
    { host: /(^|\.)instagram\.com$/, path: /^\/(p|reel|reels|tv|stories)\//, dropAll: true },
    { host: /(^|\.)linkedin\.com$/, path: /^\/(posts|feed\/update|in|company|pulse)\//, dropAll: true },
    { host: /(^|\.)tiktok\.com$/, path: /\/(video|photo)\//, dropAll: true },
];

// Wrapper links that just bounce you to the real URL (safelinks, Google's /url?q=, Facebook's l.php ...).
interface Redirector {
    host: RegExp;
    path?: RegExp;
    param: string;
}

const REDIRECTORS: Redirector[] = [
    { host: /^(www\.)?google\.[a-z.]+$/, path: /^\/url$/, param: "q" },
    { host: /^(www\.)?google\.[a-z.]+$/, path: /^\/url$/, param: "url" },
    { host: /(^|\.)facebook\.com$/, path: /^\/l\.php$/, param: "u" },
    { host: /^l\.instagram\.com$/, param: "u" },
    { host: /(^|\.)linkedin\.com$/, path: /^\/(redir\/redirect|safety\/go)\/?$/, param: "url" },
    { host: /(^|\.)youtube\.com$/, path: /^\/redirect$/, param: "q" },
    { host: /^duckduckgo\.com$/, path: /^\/l\/?$/, param: "uddg" },
    { host: /\.safelinks\.protection\.outlook\.com$/, param: "url" },
    { host: /^slack-redir\.net$/, path: /^\/link$/, param: "url" },
    { host: /^out\.reddit\.com$/, param: "url" },
    { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, param: "url" },
];

const MAX_UNWRAP_DEPTH = 3;

function unwrapRedirect(url: URL): URL | null {
    for (const rule of REDIRECTORS) {
        if (!rule.host.test(url.hostname) || (rule.path && !rule.path.test(url.pathname))) {
            continue;
        }
        const target = url.searchParams.get(rule.param);
        if (!target || !/^https?:\/\//i.test(target)) {
            continue;
        }
        try {
            return new URL(target);
        } catch {}
    }
    return null;
}

const AMAZON_ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Parses text that is *only* a web address. Needs an explicit http(s)://
 * or a leading "www." so file names like "README.md" are never mistaken
 * for links.
 */
export function parseUrlInput(text: string): URL | null {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed)) {
        return null;
    }
    let candidate: string | null = null;
    if (/^https?:\/\//i.test(trimmed)) {
        candidate = trimmed;
    } else if (/^www\.[^./]+\./i.test(trimmed)) {
        candidate = `https://${trimmed}`;
    }
    if (!candidate) {
        return null;
    }
    try {
        const url = new URL(candidate);
        return url.hostname.includes(".") || url.hostname === "localhost" ? url : null;
    } catch {
        return null;
    }
}

/**
 * Removes tracking parameters from a URL and unwraps known redirect links.
 * Non-http(s) input, or input that isn't a URL at all, comes back unchanged.
 * Untouched query strings keep their original encoding byte for byte.
 */
export function cleanUrl(input: string): CleanResult {
    const original = input.trim();
    let url = parseUrlInput(original);
    if (!url) {
        return { url: original, removed: [] };
    }

    let unwrapped = false;
    for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
        const next = unwrapRedirect(url);
        if (!next) {
            break;
        }
        url = next;
        unwrapped = true;
    }

    const host = url.hostname.toLowerCase();
    const removed: string[] = [];

    // Amazon product pages collapse to /dp/ASIN.
    if (/(^|\.)amazon\.[a-z.]+$/.test(host)) {
        const match = url.pathname.match(AMAZON_ASIN_RE);
        if (match) {
            const canonical = `${url.origin}/dp/${(match[1] ?? "").toUpperCase()}`;
            return { url: canonical, removed: queryKeys(url) };
        }
    }

    const rules = SITE_RULES.filter((r) => r.host.test(host) && (!r.path || r.path.test(url.pathname)));
    const dropAll = rules.some((r) => r.dropAll);
    const siteDrop = new Set(rules.flatMap((r) => r.drop ?? []));

    const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
    const kept: string[] = [];
    if (rawQuery) {
        for (const pair of rawQuery.split("&")) {
            if (!pair) {
                continue;
            }
            const name = paramName(pair);
            const isTracking = dropAll || TRACKING_PARAMS.has(name) || siteDrop.has(name) || TRACKING_PREFIXES.some((p) => name.startsWith(p));
            if (isTracking) {
                removed.push(name);
            } else {
                kept.push(pair);
            }
        }
    }

    if (removed.length === 0 && !unwrapped) {
        return { url: original.match(/^https?:\/\//i) ? original : url.href, removed };
    }

    const query = kept.length > 0 ? `?${kept.join("&")}` : "";
    return { url: `${url.origin}${url.pathname}${query}${url.hash}`, removed };
}

function paramName(pair: string): string {
    return safeDecode(pair.split("=")[0] ?? "").toLowerCase();
}

function queryKeys(url: URL): string[] {
    const raw = url.search.startsWith("?") ? url.search.slice(1) : "";
    return raw.split("&").filter(Boolean).map(paramName);
}

/** Origin + path only: no query string, no hash. */
export function stripQueryAndHash(url: string): string {
    const parsed = parseUrlInput(url);
    return parsed ? `${parsed.origin}${parsed.pathname}` : url;
}

/* -------------------------------------------------------------------------- */
/* Utility rows for the overlay                                               */
/* -------------------------------------------------------------------------- */

function escapeMarkdownText(text: string): string {
    return text.replace(/([[\]\\])/g, "\\$1");
}

function summarize(items: string[], max = 3): string {
    const shown = items.slice(0, max).join(", ");
    return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

function emailActions(emails: string[]): UtilAction[] {
    if (emails.length > 1) {
        const domains = [...new Set(emails.map(emailDomain))];
        const roots = [...new Set(domains.map(rootDomain))];
        const actions: UtilAction[] = [
            {
                id: "email-domains",
                label: `${domains.length} unique domain${domains.length === 1 ? "" : "s"} from ${emails.length} emails, one per line`,
                value: domains.join("\n"),
                display: summarize(domains),
                action: "copy",
            },
        ];
        if (roots.length !== domains.length || roots.some((r, i) => r !== domains[i])) {
            actions.push({
                id: "email-root-domains",
                label: "Root domains, one per line",
                value: roots.join("\n"),
                display: summarize(roots),
                action: "copy",
            });
        }
        actions.push({
            id: "email-list",
            label: "Clean email list, one per line",
            value: emails.map((e) => e.toLowerCase()).join("\n"),
            display: summarize(emails.map((e) => e.toLowerCase())),
            action: "copy",
        });
        return actions;
    }

    const email = emails[0] ?? "";
    const domain = emailDomain(email);
    const root = rootDomain(domain);
    const actions: UtilAction[] = [{ id: "email-domain", label: "Domain", value: domain, action: "copy" }];
    if (root !== domain) {
        actions.push({ id: "email-root-domain", label: "Root domain", value: root, action: "copy" });
    }
    actions.push({ id: "email-website", label: "Open website", value: `https://${root}`, action: "open" });
    actions.push({ id: "email-clean", label: "Email address (cleaned)", value: email.toLowerCase(), action: "copy" });
    return actions;
}

function buildUrlRows(clean: string, removed: string[], tabs: TabLike[]): UtilAction[] {
    const parsed = parseUrlInput(clean);
    if (!parsed) {
        return [];
    }
    const host = stripWww(parsed.hostname.toLowerCase());
    const root = rootDomain(host);

    const trackerNote = removed.length > 0 ? `Clean link, removed ${summarize([...new Set(removed)], 4)}` : "Clean link (no trackers found)";
    const actions: UtilAction[] = [{ id: "url-clean", label: trackerNote, value: clean, action: "copy" }];

    const bare = stripQueryAndHash(clean);
    if (bare !== clean && bare !== `${clean}/`) {
        actions.push({ id: "url-bare", label: "Without query and hash", value: bare, action: "copy" });
    }

    actions.push({ id: "url-domain", label: "Domain", value: host, action: "copy" });
    if (root !== host) {
        actions.push({ id: "url-root-domain", label: "Root domain", value: root, action: "copy" });
    }

    // If the page is already open in a tab, reuse its real title for the Markdown link.
    const openTab = tabs.find((t) => t.url && t.title && cleanUrl(t.url).url === clean);
    const title = escapeMarkdownText(openTab?.title ?? host);
    actions.push({ id: "url-markdown", label: "Markdown link", value: `[${title}](${clean})`, action: "copy" });

    actions.push({ id: "url-open-clean", label: "Open clean link in a new tab", value: clean, action: "open" });
    actions.push({ id: "url-wayback", label: "Open in the Wayback Machine", value: `https://web.archive.org/web/${clean}`, action: "open" });
    return actions;
}

/**
 * Utility rows for whatever is in the search box. Empty unless the whole
 * input is an email address (or a list of them) or a web address.
 */
export function buildUtilities(query: string, tabs: TabLike[] = []): UtilAction[] {
    const emails = parseEmails(query);
    if (emails) {
        return emailActions(emails);
    }
    const parsed = parseUrlInput(query);
    if (parsed) {
        const { url, removed } = cleanUrl(query);
        return buildUrlRows(url, removed, tabs);
    }
    return [];
}
