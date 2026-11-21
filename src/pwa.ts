// Offline at the launch field: register the service worker and show the Offline badge.
import { $ } from "./ui";

export function initOffline() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => undefined); });
  }
  function renderOnline() {
    const off = !navigator.onLine;
    $("offline-badge").hidden = !off;
  }
  window.addEventListener("online", renderOnline);
  window.addEventListener("offline", renderOnline);
  renderOnline();
}
