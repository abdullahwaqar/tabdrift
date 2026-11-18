/**
 * Consent for sending place names to Open-Meteo (city search and forecasts).
 *
 * On Firefox versions with built-in data consent, this is the optional
 * "locationInfo" data_collection permission, which you can also revoke from
 * about:addons. On older versions, which don't know that permission, it is an
 * explicit "Allow" click in the settings drawer, stored locally.
 *
 * Nothing is ever treated as consent by accident: an API error means "no".
 */

const PERMISSION = { data_collection: ["locationInfo"] };
const FALLBACK_KEY = "local:tabdriftWeatherConsent";

type DataPermissions = { data_collection?: string[] };
type PermissionsApi = {
    getAll: () => Promise<DataPermissions>;
    contains: (p: DataPermissions) => Promise<boolean>;
    request: (p: DataPermissions) => Promise<boolean>;
    remove: (p: DataPermissions) => Promise<boolean>;
    onAdded?: { addListener: (cb: (p: DataPermissions) => void) => void };
    onRemoved?: { addListener: (cb: (p: DataPermissions) => void) => void };
};

function api(): PermissionsApi {
    return browser.permissions as unknown as PermissionsApi;
}

let supported: boolean | undefined;

/** Whether this Firefox has the built-in data_collection permission. Cached after the first check. */
export async function supportsDataConsent(): Promise<boolean> {
    if (supported === undefined) {
        try {
            const all = await api().getAll();
            supported = Array.isArray(all?.data_collection);
        } catch {
            supported = false;
        }
    }
    return supported;
}

/** Call early (e.g. when the drawer is built) so a later click can ask without awaiting first. */
export function primeConsentSupport(): void {
    void supportsDataConsent();
}

export async function hasLocationConsent(): Promise<boolean> {
    if (await supportsDataConsent()) {
        try {
            return await api().contains(PERMISSION);
        } catch {
            return false;
        }
    }
    try {
        const stored = await browser.storage.local.get(FALLBACK_KEY);
        return stored[FALLBACK_KEY] === true;
    } catch {
        return false;
    }
}

/**
 * Asks for consent. Must be called straight from a click, before anything else
 * awaits, or Firefox refuses to show its prompt.
 */
export function requestLocationConsent(): Promise<boolean> {
    if (supported === false) {
        // No browser prompt exists here, so the click on our own "Allow" button is the consent.
        return browser.storage.local
            .set({ [FALLBACK_KEY]: true })
            .then(() => true)
            .catch(() => false);
    }
    try {
        return api()
            .request(PERMISSION)
            .catch((err) => {
                console.warn("[tabdrift] location consent request failed:", err);
                return false;
            });
    } catch (err) {
        console.warn("[tabdrift] location consent request failed:", err);
        return Promise.resolve(false);
    }
}

export async function revokeLocationConsent(): Promise<void> {
    await browser.storage.local.remove(FALLBACK_KEY).catch(() => {});
    if (await supportsDataConsent()) {
        await api()
            .remove(PERMISSION)
            .catch(() => {});
    }
}

/** Fires when consent is given or taken away anywhere (including about:addons or another tab). */
export function onLocationConsentChanged(callback: () => void): void {
    const relevant = (p: DataPermissions) => p?.data_collection?.includes("locationInfo");
    try {
        api().onAdded?.addListener((p) => relevant(p) && callback());
        api().onRemoved?.addListener((p) => relevant(p) && callback());
    } catch {
        // Older Firefox: the fallback flag below covers it.
    }
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && FALLBACK_KEY in changes) {
            callback();
        }
    });
}
