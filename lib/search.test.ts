import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_ID, engineById, parseAddress, parseEngineKey, SEARCH_ENGINES } from "./search";

describe("engines", () => {
    it("keeps the four engines and their one-letter keys", () => {
        expect(SEARCH_ENGINES.map((e) => [e.id, e.key])).toEqual([
            ["google", "g"],
            ["bing", "b"],
            ["duckduckgo", "d"],
            ["duckduckgo-noai", "n"],
        ]);
    });

    it("falls back to the default engine for unknown ids", () => {
        expect(DEFAULT_ENGINE_ID).toBe("google");
        expect(engineById(undefined).id).toBe("google");
        expect(engineById("nope").id).toBe("google");
        expect(engineById("bing").id).toBe("bing");
    });

    it("builds encoded search URLs", () => {
        expect(engineById("google").searchUrl("a&b c")).toBe("https://www.google.com/search?q=a%26b%20c");
        expect(engineById("duckduckgo-noai").searchUrl("x")).toBe("https://noai.duckduckgo.com/?q=x");
    });
});

describe("parseEngineKey", () => {
    it("reads a key before the query", () => {
        const r = parseEngineKey("g esp32 pinout");
        expect(r?.engine.id).toBe("google");
        expect(r?.query).toBe("esp32 pinout");
    });

    it("reads a key after the query", () => {
        const r = parseEngineKey("esp32 pinout b");
        expect(r?.engine.id).toBe("bing");
        expect(r?.query).toBe("esp32 pinout");
    });

    it("prefers the key at the start", () => {
        const r = parseEngineKey("g plan b");
        expect(r?.engine.id).toBe("google");
        expect(r?.query).toBe("plan b");
    });

    it("treats a trailing d as DuckDuckGo (the full text stays a plain search elsewhere)", () => {
        const r = parseEngineKey("vitamin d");
        expect(r?.engine.id).toBe("duckduckgo");
        expect(r?.query).toBe("vitamin");
    });

    it("is case-insensitive for the key", () => {
        expect(parseEngineKey("N cats")?.engine.id).toBe("duckduckgo-noai");
    });

    it("returns null with no key, or only a key", () => {
        expect(parseEngineKey("esp32 pinout")).toBeNull();
        expect(parseEngineKey("g")).toBeNull();
        expect(parseEngineKey("")).toBeNull();
        expect(parseEngineKey("yt lofi")).toBeNull();
    });
});

describe("parseAddress", () => {
    it("accepts full links as explicit", () => {
        expect(parseAddress("https://example.com/a")).toEqual({ url: "https://example.com/a", explicit: true });
    });

    it("accepts bare hosts and paths", () => {
        expect(parseAddress("github.com/user/repo")).toEqual({ url: "https://github.com/user/repo", explicit: false });
        expect(parseAddress("docs.rs")).toEqual({ url: "https://docs.rs/", explicit: false });
    });

    it("accepts localhost and IPs over http", () => {
        expect(parseAddress("localhost:5173")?.url).toBe("http://localhost:5173/");
        expect(parseAddress("192.168.1.1")?.url).toBe("http://192.168.1.1/");
    });

    it("leaves file names, spaces and emails alone", () => {
        expect(parseAddress("README.md")).toBeNull();
        expect(parseAddress("main.ts")).toBeNull();
        expect(parseAddress("two words")).toBeNull();
        expect(parseAddress("me@example.com")).toBeNull();
    });
});
