import { describe, expect, it } from "vitest";
import { duplicateKey, exactPageKey, findDuplicates } from "./utils";

describe("exactPageKey", () => {
    it("keeps SPA routes in the fragment apart", () => {
        const a = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWkqrbbn";
        const b = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKmPwzLcd";
        // The loose key (used for marks) still folds them together...
        expect(duplicateKey(a)).toBe(duplicateKey(b));
        // ...but the key used for closing tabs does not.
        expect(exactPageKey(a)).not.toBe(exactPageKey(b));
    });

    it("still ignores tracking parameters, a trailing slash and an empty #", () => {
        expect(exactPageKey("https://example.com/docs/?utm_source=x")).toBe(exactPageKey("https://example.com/docs"));
        expect(exactPageKey("https://example.com/docs#")).toBe(exactPageKey("https://example.com/docs"));
    });
});

describe("findDuplicates", () => {
    const tab = (id: number, url: string, extra: Record<string, unknown> = {}) => ({ id, url, lastAccessed: id, ...extra });

    it("does not treat two Gmail threads as duplicates", () => {
        const tabs = [tab(1, "https://mail.google.com/mail/u/0/#inbox/aaa"), tab(2, "https://mail.google.com/mail/u/0/#inbox/bbb")];
        expect(findDuplicates(tabs)).toEqual([]);
    });

    it("does not treat the same page in two containers as duplicates", () => {
        const tabs = [
            tab(1, "https://dash.example.com/", { cookieStoreId: "firefox-container-1" }),
            tab(2, "https://dash.example.com/", { cookieStoreId: "firefox-container-2" }),
        ];
        expect(findDuplicates(tabs)).toEqual([]);
    });

    it("does not mix private and normal tabs", () => {
        const tabs = [tab(1, "https://example.com/"), tab(2, "https://example.com/", { incognito: true })];
        expect(findDuplicates(tabs)).toEqual([]);
    });

    it("closes real duplicates in the same container, keeping the most recent", () => {
        const tabs = [
            tab(1, "https://example.com/a?utm_source=x", { cookieStoreId: "firefox-default" }),
            tab(3, "https://example.com/a", { cookieStoreId: "firefox-default" }),
            tab(2, "https://example.com/a/", { cookieStoreId: "firefox-default" }),
        ];
        expect(findDuplicates(tabs).map((t) => t.id)).toEqual([1, 2]);
    });

    it("never closes the current or a pinned tab", () => {
        const tabs = [tab(1, "https://example.com/", { current: true }), tab(2, "https://example.com/", { pinned: true }), tab(3, "https://example.com/")];
        expect(findDuplicates(tabs).map((t) => t.id)).toEqual([3]);
    });
});
