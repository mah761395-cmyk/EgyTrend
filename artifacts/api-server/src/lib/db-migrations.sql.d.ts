/**
 * Reviewed SQL migration files are imported as plain text strings.
 *
 * `artifacts/api-server/build.mjs` configures esbuild with a `text` loader for
 * `*.sql`, so the SQL is inlined into the serverless bundle — the deployment
 * never needs the migration files on disk at runtime.
 */
declare module "*.sql" {
  const contents: string;
  export default contents;
}
