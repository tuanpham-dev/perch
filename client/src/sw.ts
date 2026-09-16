/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa's injectManifest strategy — see
// vite.config.ts) so push/notificationclick handlers can sit alongside the
// generated precache manifest. Typechecked separately (tsconfig.sw.json,
// excluded from the main app's DOM-lib tsconfig — see its comment) since
// this file's `self` is ServiceWorkerGlobalScope, not Window.
import { clientsClaim } from "workbox-core";
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Without these, a newly-installed SW sits in "waiting" — the browser
// default — until every tab open from before the deploy is fully closed,
// not just reloaded. For an app people tend to leave open in a pinned tab
// or installed PWA, that's effectively "the deploy never applies." Deriving
// from vite.config.ts's registerType: "autoUpdate" client-side setting,
// which already expects new-SW installs to take over immediately — that
// setting alone does nothing for an injectManifest SW like this one unless
// it actually skips waiting itself.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

interface BellPushPayload {
  title?: string;
  body?: string;
  pane?: string;
}

// Web-push notifications (plans/codeman-mobile-features.md Phase 4): the
// server (server/src/push.ts) sends one push per subscribed browser when a
// terminal rings the bell (Claude Code bells on permission prompts).
self.addEventListener("push", (event: PushEvent) => {
  let data: BellPushPayload = {};
  try {
    data = (event.data?.json() as BellPushPayload) ?? {};
  } catch {
    // Non-JSON or empty payload — still show a generic notification rather
    // than silently dropping a push the user explicitly subscribed to.
  }
  const title = data.title || "Perch";
  const body = data.body || "A pane needs your attention";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      // Same pane replaces its own prior notification instead of stacking —
      // a pane that keeps bouncing the bell (past the server's own rate
      // limit resetting) shouldn't flood the notification tray.
      tag: data.pane,
      data: { pane: data.pane },
    }),
  );
});

// Focuses an already-open tab rather than always opening a new one — most
// users tapping the notification want to get back to the app they already
// have open, not accumulate duplicate tabs every time a pane bells.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow("/");
      }
    })(),
  );
});
