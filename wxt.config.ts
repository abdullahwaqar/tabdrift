import { defineConfig } from "wxt";

export default defineConfig({
    manifestVersion: 3,
    manifest: {
        name: "Tabdrift",
        description: "A fast tab switcher. Default: Alt+Shift+K.",
        version: "2.0.4",
        permissions: ["tabs", "activeTab", "storage", "scripting", "history", "clipboardWrite", "contextMenus", "topSites", "alarms"],
        // Asked for from the new tab page when you turn on "Notify when a session ends".
        optional_permissions: ["notifications"],
        commands: {
            _execute_action: {
                suggested_key: {
                    default: "Alt+Shift+K",
                },
            },
            "copy-clean-url": {
                suggested_key: {
                    default: "Alt+Shift+C",
                },
                description: "Copy this page's link without tracking parameters",
            },
        },
        icons: {
            16: "/icons/icon-16.png",
            32: "/icons/icon-32.png",
            48: "/icons/icon-48.png",
            128: "/icons/icon-128.png",
        },
        action: {
            default_title: "Tabdrift (Alt+Shift+K)",
            default_icon: {
                16: "/icons/icon-16.png",
                32: "/icons/icon-32.png",
                48: "/icons/icon-48.png",
                128: "/icons/icon-128.png",
            },
        },
        browser_specific_settings: {
            gecko: {
                id: "tabdrift@abdullahwaqar.com",
                strict_min_version: "109.0",
                data_collection_permissions: {
                    required: ["none"],
                    // Only if you turn on the new tab weather: the place you pick goes to Open-Meteo.
                    optional: ["locationInfo"],
                },
            },
        },
    },
});
