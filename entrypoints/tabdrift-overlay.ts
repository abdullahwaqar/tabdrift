import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { mountPalette } from "../lib/palette";

// Injected into the page on demand by the background script.
export default defineUnlistedScript(() => {
    const win = window as unknown as { __tabSearchInjected?: boolean };
    if (win.__tabSearchInjected) {
        return;
    }
    win.__tabSearchInjected = true;
    mountPalette("page");
});
