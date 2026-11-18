import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyImport, applyToggle, MAX_MARKS, type Mark, markStore } from "./marks";

/** In-memory storage.local where every get/set yields, so overlapping edits really interleave. */
function mockStorage() {
    const data: Record<string, unknown> = {};
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const local = {
        get: vi.fn(async (key: string) => {
            await tick();
            return { [key]: structuredClone(data[key]) };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
            await tick();
            Object.assign(data, structuredClone(items));
        }),
    };
    (globalThis as { browser?: unknown }).browser = { storage: { local } };
    return data;
}

const mark = (i: number): Mark => ({ key: `https://e.com/${i}`, url: `https://e.com/${i}`, title: `${i}`, createdAt: i, openCount: 0 });

describe("mark queue", () => {
    let data: Record<string, unknown>;
    beforeEach(() => {
        data = mockStorage();
    });

    it("keeps both marks when two are added at the same time", async () => {
        const [a, b] = await Promise.all([markStore.toggle({ url: "https://a.com/" }), markStore.toggle({ url: "https://b.com/" })]);
        expect([a, b]).toEqual(["marked", "marked"]);
        const saved = (data["local:marks"] as Mark[]).map((m) => m.url).sort();
        expect(saved).toEqual(["https://a.com/", "https://b.com/"]);
    });

    it("doesn't lose a mark when an open is counted while another page is marked", async () => {
        await markStore.toggle({ url: "https://a.com/" });
        const key = (data["local:marks"] as Mark[])[0]?.key ?? "";
        await Promise.all([markStore.opened(key), markStore.toggle({ url: "https://b.com/" }), markStore.opened(key)]);
        const saved = data["local:marks"] as Mark[];
        expect(saved).toHaveLength(2);
        expect(saved.find((m) => m.key === key)?.openCount).toBe(2);
    });

    it("keeps working after a failed write", async () => {
        const local = (globalThis as unknown as { browser: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }).browser.storage.local;
        local.set.mockRejectedValueOnce(new Error("quota"));
        await expect(markStore.toggle({ url: "https://a.com/" })).rejects.toThrow("quota");
        await expect(markStore.toggle({ url: "https://b.com/" })).resolves.toBe("marked");
    });
});

describe("mark cap", () => {
    it("refuses a new mark when full instead of dropping the oldest", () => {
        const full = Array.from({ length: MAX_MARKS }, (_, i) => mark(i));
        const edit = applyToggle(full, { url: "https://new.com/" });
        expect(edit.result).toBe("full");
        expect(edit.next).toBeNull();
    });

    it("reports imported marks that didn't fit", () => {
        const almost = Array.from({ length: MAX_MARKS - 2 }, (_, i) => mark(i));
        const edit = applyImport(almost, [{ url: "https://x.com/1" }, { url: "https://x.com/2" }, { url: "https://x.com/3" }, { url: "https://x.com/4" }]);
        expect(edit.result).toEqual({ added: 2, skipped: 2 });
        expect(edit.next).toHaveLength(MAX_MARKS);
    });

    it("doesn't count duplicates or existing marks as imported", () => {
        const edit = applyImport(
            [mark(1)],
            [{ url: "https://e.com/1" }, { url: "https://y.com/" }, { url: "https://y.com/?utm_source=z" }, { url: "javascript:alert(1)" }],
        );
        expect(edit.result).toEqual({ added: 1, skipped: 0 });
    });
});
