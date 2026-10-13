/**
 * Last observed health of each external provider.
 *
 * Why this exists
 * ───────────────
 * A dead OAuth refresh token (`invalid_grant`) used to be invisible: the
 * calendar silently served a synthetic schedule and the mail reader just
 * 502'd, with nothing in the health endpoint to say so. An outage was only
 * discoverable by noticing the data looked wrong.
 *
 * Providers report the outcome of each real call here, and `/api/healthz`
 * surfaces it, so "calendar is down" is a thing monitoring can see rather than
 * a thing the boss has to be fooled by. State is per-instance and reflects the
 * most recent call, not a live probe — a cold instance that has served no
 * provider request reports nothing yet, which is honest.
 */

const state = new Map();

export function markProviderOk(name) {
  state.set(name, { ok: true, error: null, at: new Date().toISOString() });
}

export function markProviderFail(name, error) {
  state.set(name, {
    ok: false,
    error: String(error?.message ?? error ?? "unknown error"),
    at: new Date().toISOString(),
  });
}

export function getProviderHealth() {
  return Object.fromEntries(state);
}
