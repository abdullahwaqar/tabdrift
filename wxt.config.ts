import { defineConfig } from "wxt";

export default defineConfig({
    manifestVersion: 3,
    manifest: {
        name: "Tabdrift",
        description: "A fast tab switcher. Default: Alt+Shift+K.",
        version: "1.0.0",
        permissions: ["tabs", "activeTab", "storage", "scripting"],
        commands: {
            _execute_action: {
                suggested_key: {
                    default: "Alt+Shift+K",
                },
            },
        },
        action: {
            default_title: "Tabdrift (Alt+Shift+K)",
        },
        browser_specific_settings: {
            gecko: {
                id: "tabdrift@abdullahwaqar@pm.me",
                strict_min_version: "109.0",
                data_collection_permissions: {
                    required: ["none"],
                },
            },
        },
    },
});
