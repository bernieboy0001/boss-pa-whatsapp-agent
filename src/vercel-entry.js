import { app } from "./server.js";

/**
 * Vercel serverless entry.
 *
 * Exported as a plain (req, res) handler rather than a bare Express instance.
 * Vercel special-cases a default-exported Express app and mounts it at the
 * function path, which strips the `/api` prefix and breaks every route we
 * declare as `/api/day`. Invoking the app directly as a function keeps the
 * original URL intact, so the Express routes match exactly.
 *
 * This file is compiled by esbuild into `api/[...path].js` (see `npm run build:api`),
 * which inlines every `src/` import. That is what fixes ERR_MODULE_NOT_FOUND:
 * unbundled relative imports from `api/` are not traced into the function.
 */
export default function handler(req, res) {
  return app(req, res);
}
