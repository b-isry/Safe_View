// SafeView — beepNotification.ts
// On-screen proof that profanity BEEP fired (YouTube overlay).

const BEEP_NOTIFICATION_ID = "sv-beep-triggered-notification";
const BEEP_NOTIFICATION_VISIBLE_MS = 3500;

let hideTimeoutId: ReturnType<typeof setTimeout> | null = null;

function injectBeepNotificationStyles(): void {
  if (document.getElementById("sv-beep-notification-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "sv-beep-notification-styles";
  style.textContent = `
    #${BEEP_NOTIFICATION_ID} {
      position: fixed;
      top: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      padding: 14px 28px;
      border-radius: 8px;
      background: rgba(220, 38, 38, 0.95);
      color: #fff;
      font-family: "YouTube Noto", Roboto, Arial, sans-serif;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    #${BEEP_NOTIFICATION_ID}.sv-beep-visible {
      opacity: 1;
    }
  `;
  document.documentElement.appendChild(style);
}

/**
 * Show a visible "BEEP TRIGGERED" banner on the player when profanity matches.
 */
export function showBeepTriggeredNotification(): void {
  injectBeepNotificationStyles();

  let banner = document.getElementById(BEEP_NOTIFICATION_ID);
  if (!banner) {
    banner = document.createElement("div");
    banner.id = BEEP_NOTIFICATION_ID;
    banner.setAttribute("aria-live", "assertive");
    banner.textContent = "BEEP TRIGGERED";
    document.documentElement.appendChild(banner);
  }

  banner.textContent = "BEEP TRIGGERED";
  banner.classList.add("sv-beep-visible");

  if (hideTimeoutId !== null) {
    clearTimeout(hideTimeoutId);
  }

  hideTimeoutId = window.setTimeout(() => {
    hideTimeoutId = null;
    banner?.classList.remove("sv-beep-visible");
  }, BEEP_NOTIFICATION_VISIBLE_MS);

  console.info("[SafeView] Visual BEEP TRIGGERED notification displayed.");
}
