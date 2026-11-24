// Landing page analytics: a page view plus clicks on the main calls to action.
import { initAnalytics, track } from "../analytics.js";

initAnalytics("landing");

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element && event.target.closest("a");
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  if (href.startsWith("./wallet/"))
    track("landing_wallet_clicked", { placement: placementOf(link) });
  else if (href.startsWith("./docs/"))
    track("landing_docs_clicked", {
      doc: href.replace(/^\.\/docs\//u, "").replace(/\.html$/u, ""),
      placement: placementOf(link),
    });
  else if (/github\.com|npmjs\.com/u.test(href))
    track("landing_external_clicked", {
      destination: href.includes("npmjs.com") ? "npm" : "github",
      placement: placementOf(link),
    });
});

function placementOf(link) {
  return link.closest("footer")
    ? "footer"
    : link.closest("nav, header")
      ? "header"
      : "body";
}
