/**
 * Tab and window commands the overlay asks the background script to run.
 * Shared so both sides agree on the names.
 */
export type TabCommandId =
    | "pin"
    | "mute"
    | "reload"
    | "hard-reload"
    | "duplicate"
    | "new-window"
    | "discard"
    | "close-site"
    | "close-others"
    | "close-right"
    | "close-left"
    | "sort-window"
    | "merge-windows"
    | "discard-inactive"
    | "mute-others";

export interface TabCommandReply {
    success: boolean;
    /** Shown in the overlay footer. */
    message?: string;
}
