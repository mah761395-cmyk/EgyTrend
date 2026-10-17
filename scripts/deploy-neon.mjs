#!/usr/bin/env node
/**
 * RETIRED — deliberately refuses to connect to Neon or copy a database.
 *
 * The former helper created an outdated partial schema, could copy data from a
 * local database without a recovery point, and seeded payment settings. It is
 * not compatible with the reviewed migration sequence in lib/db/migrations.
 *
 * Safe deployment work must use the paired migration files only after all of:
 *   1. an isolated Preview/Test DATABASE_URL is verified;
 *   2. a real pg_dump backup is created and verified outside the artifact;
 *   3. the exact up/down SQL is reviewed and an approved deployment window
 *      and rollback plan exist.
 *
 * This script intentionally does not parse, print, or connect with any URL.
 */
console.error("Refusing legacy Neon deployment: scripts/deploy-neon.mjs is retired.");
console.error("Use lib/db/migrations/README.md and the approved migration runner after a verified backup.");
process.exitCode = 1;
