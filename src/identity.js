import { cfg } from "./config.js";
import { getPrefs } from "./prefs.js";
import { currentUser } from "./context.js";

/**
 * Identity-derived values that used to be global config.
 *
 * The app assumed one boss: `cfg.bossTimezone` and `cfg.bossCalendarEmail` were
 * read straight from the environment. In multi-user mode those must follow the
 * signed-in account instead. These helpers resolve against the current request
 * context and fall back to the original env values, so single-tenant behaviour
 * (and the Webhook, which has no user) is unchanged.
 */

const DEFAULT_TZ = "Africa/Lagos";

/** The active user's home timezone: their stored preference, else the env default. */
export function homeTimezone() {
  const pref = getPrefs()?.bossZone;
  return pref || cfg.bossTimezone || DEFAULT_TZ;
}

/** The mailbox / calendar address for the active identity. */
export function accountEmail() {
  return currentUser()?.email || cfg.bossCalendarEmail || "";
}
