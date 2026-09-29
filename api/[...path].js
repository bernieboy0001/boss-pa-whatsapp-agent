// COMMITTED SHIM — do not replace with the bundle.
//
// Vercel validates `functions` patterns from vercel.json at the very start of
// `vercel build`, BEFORE installCommand and buildCommand run. So a function
// file that only exists after `npm run build:api` can never satisfy the
// pattern, and every GitHub-triggered deploy fails with:
//
//   The pattern "api/[...path].js" defined in `functions` doesn't match any
//   Serverless Functions inside the `api` directory.
//
// (That is why local `vercel --prod` uploads worked while every `git push`
// auto-deploy failed: the CLI uploaded the locally-generated bundle.)
//
// Keeping this committed shim makes the pattern match on a fresh clone, while
// the real self-contained bundle is generated into build/server.js and traced
// in as a relative import during function packaging.
export { default } from "../build/server.js";
