import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request user context.
 *
 * The whole app below the HTTP layer was written single-tenant: tools read
 * `cfg.bossTimezone`, the store read one fixed key space, and one Google token
 * served everyone. Rather than thread a `user` argument through every tool and
 * session call (large, risky, easy to miss a spot), the request's identity is
 * parked in an AsyncLocalStorage and read back synchronously where it is
 * needed:
 *
 *   - store.js namespaces every record by the current scope
 *   - oauth2-client.js resolves the current user's own refresh token
 *   - identity.js resolves the current user's timezone / account email
 *
 * Scope model
 * ───────────
 * The pre-existing single account keeps its original storage keys, so its live
 * data (calendar token, preferences, reminders) is preserved with no migration.
 * Concretely, `scopeId` is:
 *
 *   ""           the owner / single-tenant mode  → flexagent:<ns>:<id>
 *   "u:<sub>"    any other signed-in user        → flexagent:u:<sub>:<ns>:<id>
 *
 * So when auth is not configured (local dev, smoke tests, WhatsApp webhook) the
 * context is empty and every namespace resolves exactly as before `undefined` →
 * empty scope.
 */

const storage = new AsyncLocalStorage();

/** Run `fn` with `user` ({ id, email, name, picture, isOwner }) as the active identity. */
export function runWithUser(user, fn) {
  return storage.run({ user: user ?? null }, fn);
}

/** The active user record, or null when unauthenticated / single-tenant mode. */
export function currentUser() {
  return storage.getStore()?.user ?? null;
}

/**
 * The storage scope for the active identity. Empty string means "the original
 * unscoped key space" (owner + single-tenant). Callers use this to build key
 * prefixes and to key per-user caches.
 */
export function scopeId() {
  const user = currentUser();
  if (!user) return "";
  return user.isOwner ? "" : `u:${user.id}`;
}

/** True when the active identity may fall back to the single-tenant env token. */
export function isOwnerScope() {
  return scopeId() === "";
}
