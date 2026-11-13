import { describe, expect, it } from "vitest";
import type { SearchProvider } from "./providers";
import { activeProviders, BUILTIN_PROVIDERS, isValidTemplate, keyProblem, parseProviderKey, providerUrl } from "./providers";
import type { WebRowContext } from "./web-rows";
import { planWebRows } from "./web-rows";

const builtins = activeProviders([], true);

describe("keys and templates", () => {
    it("rejects engine keys, scope symbols and junk", () => {
        expect(keyProblem("yt")).toBeNull();
        expect(keyProblem("YT")).toBeNull();
        expect(keyProblem("g")).toBe("reserved");
        expect(keyProblem("n")).toBe("reserved");
        for (const k of ["%", "*", "^", ">", "!yt", "'yt", "a b"]) {
            expect(keyProblem(k)).toBe("format");
        }
        expect(keyProblem("  ")).toBe("empty");
    });

    it("needs an http(s) address with a placeholder", () => {
        expect(isValidTemplate("https://x.com/s?q={q}")).toBe(true);
        expect(isValidTemplate("https://x.com/s?q=%s")).toBe(true);
        expect(isValidTemplate("https://x.com/s")).toBe(false);
        expect(isValidTemplate("javascript:alert({q})")).toBe(false);
        expect(isValidTemplate("ftp://x.com/{q}")).toBe(false);
    });

    it("encodes the query into every placeholder", () => {
        const p: SearchProvider = { id: "t", name: "T", keys: ["t"], url: "https://x.com/{q}?also=%s" };
        expect(providerUrl(p, "a&b c/d")).toBe("https://x.com/a%26b%20c%2Fd?also=a%26b%20c%2Fd");
    });

    it("built-ins all have valid keys and addresses", () => {
        expect(builtins).toHaveLength(BUILTIN_PROVIDERS.length);
    });
});

describe("parseProviderKey", () => {
    it("reads a key at the start", () => {
        const r = parseProviderKey("ytm Bohemian Rhapsody", builtins);
        expect(r?.provider.id).toBe("youtube-music");
        expect(r?.query).toBe("Bohemian Rhapsody");
        expect(r?.url).toBe("https://music.youtube.com/search?q=Bohemian%20Rhapsody");
    });

    it("ignores a key at the end, a key alone, and unknown keys", () => {
        expect(parseProviderKey("lofi yt", builtins)).toBeNull();
        expect(parseProviderKey("yt", builtins)).toBeNull();
        expect(parseProviderKey("yt   ", builtins)).toBeNull();
        expect(parseProviderKey("zz lofi", builtins)).toBeNull();
    });

    it("lets your own provider win a key clash", () => {
        const mine: SearchProvider = { id: "custom-1", name: "Invidious", keys: ["yt"], url: "https://yewtu.be/search?q={q}" };
        expect(parseProviderKey("yt lofi", activeProviders([mine], true))?.provider.id).toBe("custom-1");
    });

    it("drops broken entries instead of failing", () => {
        const broken: SearchProvider[] = [
            { id: "a", name: "A", keys: ["g"], url: "https://a.com/{q}" },
            { id: "b", name: "B", keys: ["bb"], url: "https://b.com/no-placeholder" },
            { id: "c", name: "C", keys: ["%", "cc"], url: "https://c.com/{q}" },
        ];
        const list = activeProviders(broken, false);
        expect(list.map((p) => [p.id, p.keys])).toEqual([["c", ["cc"]]]);
    });

    it("built-ins can be switched off while yours keep working", () => {
        const mine: SearchProvider = { id: "custom-1", name: "Spotify", keys: ["sp"], url: "https://open.spotify.com/search/{q}" };
        const list = activeProviders([mine], false);
        expect(parseProviderKey("yt lofi", list)).toBeNull();
        expect(parseProviderKey("sp lofi", list)?.provider.name).toBe("Spotify");
    });
});

describe("planWebRows with providers", () => {
    const nothing: WebRowContext = { engineId: "google", hasTabs: false, hasUtilities: false, hasMarks: false, providers: builtins };

    it("goes on top when nothing else matched, with the plain search below", () => {
        const plan = planWebRows("yt lofi beats", nothing);
        expect(plan.first).toBe(true);
        expect(plan.rows).toMatchObject([
            { id: "provider", title: "lofi beats", sub: "Search YouTube", badge: "yt" },
            { id: "search", title: "yt lofi beats" },
        ]);
    });

    it("never jumps above matching tabs or marks", () => {
        expect(planWebRows("gh issues", { ...nothing, hasTabs: true }).first).toBe(false);
        expect(planWebRows("gh issues", { ...nothing, hasMarks: true }).first).toBe(false);
        expect(planWebRows("gh issues", { ...nothing, hasTabs: true }).rows[0]?.id).toBe("provider");
    });

    it("leaves the engine keys exactly as they were", () => {
        expect(planWebRows("g lofi", nothing).rows[0]).toMatchObject({ id: "search-keyed", badge: "g" });
        // An engine key at the end still wins over a provider key at the start.
        expect(planWebRows("yt lofi d", nothing).rows[0]).toMatchObject({ id: "search-keyed", title: "yt lofi", badge: "d" });
    });

    it("does nothing when providers are off", () => {
        const off = { ...nothing, providers: [] };
        expect(planWebRows("yt lofi", off)).toEqual(planWebRows("yt lofi", { ...nothing, providers: undefined }));
        expect(planWebRows("yt lofi", off).rows.map((r) => r.id)).toEqual(["search"]);
    });
});
