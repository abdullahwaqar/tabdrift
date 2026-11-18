import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fresh modules per test: location-consent caches whether data_collection is supported. */
async function load() {
    vi.resetModules();
    const consent = await import("./location-consent");
    const weather = await import("./weather");
    return { ...consent, ...weather };
}

function mockBrowser(opts: { supported: boolean; granted?: boolean; requestThrows?: boolean; stored?: Record<string, unknown> }) {
    const store: Record<string, unknown> = { ...(opts.stored ?? {}) };
    let granted = opts.granted ?? false;
    const permissions = {
        getAll: vi.fn(async () =>
            opts.supported ? { permissions: [], origins: [], data_collection: granted ? ["locationInfo"] : [] } : { permissions: [], origins: [] },
        ),
        contains: vi.fn(async () => granted),
        request: vi.fn(async () => {
            if (opts.requestThrows) {
                throw new Error("Type error for parameter permissions");
            }
            granted = true;
            return true;
        }),
        remove: vi.fn(async () => {
            granted = false;
            return true;
        }),
    };
    (globalThis as { browser?: unknown }).browser = {
        permissions,
        storage: {
            local: {
                get: vi.fn(async (k: string) => ({ [k]: store[k] })),
                set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
                remove: vi.fn(async (k: string) => {
                    delete store[k];
                }),
            },
            onChanged: { addListener: vi.fn() },
        },
    };
    return { permissions, store };
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { language: "en-US" });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const LAHORE = { name: "Lahore", detail: "Punjab, Pakistan", latitude: 31.55, longitude: 74.34 };

describe("weather consent", () => {
    it("sends nothing while you type before consent", async () => {
        mockBrowser({ supported: true, granted: false });
        const { searchPlaces, NoConsentError } = await load();
        await expect(searchPlaces("Lahore")).rejects.toBeInstanceOf(NoConsentError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("searches once consent is given", async () => {
        mockBrowser({ supported: true, granted: true });
        const { searchPlaces } = await load();
        await searchPlaces("Lahore");
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("stops forecasts as soon as consent is revoked", async () => {
        mockBrowser({ supported: true, granted: true });
        const { fetchWeather, revokeLocationConsent, NoConsentError } = await load();
        await revokeLocationConsent();
        await expect(fetchWeather(LAHORE, "celsius")).rejects.toBeInstanceOf(NoConsentError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("treats a permission API error as no, not yes", async () => {
        mockBrowser({ supported: true, requestThrows: true });
        const { requestLocationConsent, supportsDataConsent, hasLocationConsent } = await load();
        await supportsDataConsent();
        await expect(requestLocationConsent()).resolves.toBe(false);
        await expect(hasLocationConsent()).resolves.toBe(false);
    });

    it("on older Firefox, uses the explicit Allow click and can be revoked", async () => {
        const { store } = mockBrowser({ supported: false });
        const { requestLocationConsent, supportsDataConsent, hasLocationConsent, revokeLocationConsent } = await load();
        expect(await hasLocationConsent()).toBe(false);
        await supportsDataConsent();
        expect(await requestLocationConsent()).toBe(true);
        expect(await hasLocationConsent()).toBe(true);
        await revokeLocationConsent();
        expect(store).toEqual({});
        expect(await hasLocationConsent()).toBe(false);
    });
});
