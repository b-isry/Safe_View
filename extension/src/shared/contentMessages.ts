// SafeView — contentMessages.ts
// Purpose: Message action constants shared by content script modules (avoids circular imports).

/** Content script → service worker: JPEG frame for analysis. */
export const MESSAGE_ACTION_FRAME_SAMPLE = "FRAME_SAMPLE";

/** Service worker → content script: one frame analysis cycle finished. */
export const MESSAGE_ACTION_FRAME_ANALYSIS_DONE = "FRAME_ANALYSIS_DONE";
