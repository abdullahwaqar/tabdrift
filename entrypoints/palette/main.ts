import { mountPalette } from "../../lib/palette";

// The toolbar popup, used on pages Firefox won't let extensions draw on (new tab, about: pages, AMO).
browser.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => mountPalette("popup", { tabId: tab?.id, url: tab?.url }))
    .catch(() => mountPalette("popup"));
