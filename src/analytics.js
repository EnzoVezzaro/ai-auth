// Product analytics for the hosted AI Auth site (landing page and wallet).
// Only the published site loads this; the SDK packages never import it.
// Events carry no wallet IDs, origins, names, or other personal data.
// Slim, no-external build: core capture only, and it never loads remote
// scripts into the wallet page.
import posthog from "posthog-js/dist/module.slim.no-external.js";

const POSTHOG_KEY = "phc_oA9YRYsvPM4TWSAfaGwHzKeXJPsEEQKGunhTkzqALPyt";
const POSTHOG_HOST = "https://us.i.posthog.com";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

let enabled = false;

/** Initialize PostHog once. Skipped on local hosts and automated browsers. */
export function initAnalytics(page) {
  if (enabled || typeof window === "undefined") return;
  if (LOCAL_HOSTS.has(window.location.hostname) || navigator.webdriver) return;
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      persistence: "localStorage",
      // Strip query strings and fragments: wallet and connect URLs can carry
      // one-time tokens or request payloads.
      before_send: (event) => {
        if (!event?.properties) return event;
        const properties = { ...event.properties };
        for (const key of ["$current_url", "$referrer"])
          if (typeof properties[key] === "string")
            properties[key] = properties[key].split(/[?#]/u)[0];
        return { ...event, properties };
      },
    });
    posthog.register({ site_page: page });
    enabled = true;
  } catch {
    enabled = false;
  }
}

/** Capture a product event with non-identifying properties only. */
export function track(event, properties = {}) {
  if (!enabled) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Analytics must never break the wallet or landing page.
  }
}
