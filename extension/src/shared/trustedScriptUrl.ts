// SafeView — trustedScriptUrl.ts
// YouTube and other strict-CSP pages require TrustedScriptURL for HTMLScriptElement.src.

type TrustedTypesPolicy = {
  createScriptURL: (url: string) => unknown;
};

type TrustedTypesGlobal = {
  createPolicy: (
    name: string,
    rules: { createScriptURL: (url: string) => string }
  ) => TrustedTypesPolicy;
};

let safeViewPolicy: TrustedTypesPolicy | null = null;

function getSafeViewPolicy(): TrustedTypesPolicy | null {
  if (safeViewPolicy) {
    return safeViewPolicy;
  }

  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypesGlobal })
    .trustedTypes;

  if (!trustedTypes?.createPolicy) {
    return null;
  }

  try {
    safeViewPolicy = trustedTypes.createPolicy("safeview-policy", {
      createScriptURL: (url: string) => url,
    });
  } catch {
    return null;
  }

  return safeViewPolicy;
}

/**
 * Build a TrustedScriptURL (or plain string) safe for assignment to script.src.
 *
 * @param url - Absolute or extension-relative URL resolved by the caller.
 */
export function toTrustedScriptURL(url: string): string | unknown {
  const policy = getSafeViewPolicy();
  if (policy) {
    return policy.createScriptURL(url);
  }

  return url;
}

/**
 * Assign script.src without violating Trusted Types on strict pages.
 *
 * @param script - Script element to configure.
 * @param url - Fully resolved script URL (e.g. chrome.runtime.getURL(...)).
 */
export function setTrustedScriptSrc(
  script: HTMLScriptElement,
  url: string
): void {
  script.src = toTrustedScriptURL(url) as string;
}

/**
 * Append an extension script tag only when page-context injection is required.
 * Prefer manifest content_scripts; this path is CSP-guarded for Trusted Types.
 *
 * @param extensionRelativePath - Path under the extension root (passed to getURL).
 * @returns The inserted script element, or null when injection is skipped.
 */
export function appendExtensionScript(
  extensionRelativePath: string
): HTMLScriptElement | null {
  if (typeof document === "undefined" || !document.documentElement) {
    return null;
  }

  const script = document.createElement("script");
  setTrustedScriptSrc(script, chrome.runtime.getURL(extensionRelativePath));
  script.type = "text/javascript";
  (document.head ?? document.documentElement).appendChild(script);
  return script;
}
