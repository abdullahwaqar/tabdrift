import { describe, expect, it } from "vitest";
import type { WebRowContext } from "./web-rows";
import { planWebRows } from "./web-rows";

const nothing: WebRowContext = { engineId: "google", hasTabs: false, hasUtilities: false, hasMarks: false };
const withTabs: WebRowContext = { ...nothing, hasTabs: true };

const ids = (q: string, ctx: WebRowContext) => planWebRows(q, ctx).rows.map((r) => r.id);

describe("planWebRows (behavior before providers)", () => {
    it("plain search goes first only when nothing else matched", () => {
        expect(planWebRows("esp32 pinout", nothing)).toMatchObject({ first: true, rows: [{ id: "search", title: "esp32 pinout", badge: "g" }] });
        expect(planWebRows("esp32 pinout", withTabs).first).toBe(false);
        expect(planWebRows("esp32 pinout", { ...nothing, hasMarks: true }).first).toBe(false);
        expect(planWebRows("esp32 pinout", { ...nothing, hasUtilities: true }).first).toBe(false);
    });

    it("uses the chosen default engine", () => {
        const plan = planWebRows("cats", { ...nothing, engineId: "duckduckgo" });
        expect(plan.rows[0]).toMatchObject({ sub: "Search with DuckDuckGo", url: "https://duckduckgo.com/?q=cats" });
    });

    it("an engine key always goes first, with the full text one row below", () => {
        const plan = planWebRows("vitamin d", withTabs);
        expect(plan.first).toBe(true);
        expect(plan.rows).toMatchObject([
            { id: "search-keyed", title: "vitamin", badge: "d" },
            { id: "search", title: "vitamin d", badge: "g" },
        ]);
    });

    it("a full link opens on its own, on top", () => {
        const plan = planWebRows("https://example.com", withTabs);
        expect(plan.first).toBe(true);
        expect(ids("https://example.com", withTabs)).toEqual(["go"]);
    });

    it("a bare address offers open and search, on top only when no tabs matched", () => {
        expect(ids("docs.rs", withTabs)).toEqual(["go", "search"]);
        expect(planWebRows("docs.rs", withTabs).first).toBe(false);
        expect(planWebRows("docs.rs", nothing).first).toBe(true);
        // Marks don't push a bare address down (unlike a plain search).
        expect(planWebRows("docs.rs", { ...nothing, hasMarks: true }).first).toBe(true);
    });
});
