/**
 * EgyTrend — Vercel serverless entry for the Express API.
 *
 * Vercel runs a function per request, not a long-lived server, and it sets
 * VERCEL=1 so the bundled app skips app.listen() entirely (see
 * artifacts/api-server/src/index.ts). Here we simply hand every request to
 * the Express app — @vercel/node v5 injects an HTTP/1.1 server on `req`
 * (req.httpVersion === "1.1"), which is exactly what Express expects.
 */
export default async function egytrend(req, res) {
  /* Safety net: guarantee the serverless flag even if the platform var is
   * absent (self-hosted emulators etc.). Must run BEFORE the app module
   * (and its env-loading bootstrap) is imported. */
  process.env.VERCEL = process.env.VERCEL ?? "1";

  const { default: app } = await import("../artifacts/api-server/dist/index-bridge.mjs");
  return app(req, res);
}
