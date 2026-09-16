// Browser Web Push subscribe/unsubscribe flow (plans/codeman-mobile-
// features.md Phase 4). Subscription status is deliberately NOT a synced
// AppSettings field — a PushSubscription's endpoint is tied to this
// specific browser's own service worker registration, so it can't mean
// anything on another device the way a real preference would; each device
// checks its own live status via getCurrentSubscription() instead.
import * as api from "./api";

// Explicit ArrayBuffer (not the wider ArrayBufferLike a bare `new
// Uint8Array(length)` infers under TS 5.7+'s stricter typed-array generics)
// — applicationServerKey's declared type doesn't accept the wider one.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// A push subscription requires HTTPS (or localhost) — `serviceWorker` isn't
// even exposed on `navigator` outside a secure context, so isPushSupported()
// alone can't distinguish "this browser can't do push" from "this page just
// isn't loaded securely enough" (an easy trap on plain LAN HTTP). Callers use
// this to explain the difference instead of just hiding the toggle.
export function pushUnavailableReason(): string | null {
  if (!window.isSecureContext) {
    return "Push notifications need HTTPS (or localhost) - this page isn't loaded over a secure connection.";
  }
  if (!isPushSupported()) {
    return "Push notifications aren't supported in this browser.";
  }
  return null;
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api.fetchPushVapidKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.subscribePush(subscription.toJSON() as PushSubscriptionJSON);
}

export async function disablePush(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  // Server-side removal first: if unsubscribe() below throws, the
  // subscription is at worst stale server-side (self-heals on its next
  // failed push — see push.ts's notifyBell) rather than the reverse (a
  // removed local subscription the server still thinks is live and keeps
  // trying to push to, which just fails silently forever).
  await api.unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
}
