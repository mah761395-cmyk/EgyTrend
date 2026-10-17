#!/usr/bin/env node
/**
 * RETIRED — this one-off schema mutator is superseded by the reviewed paired
 * SQL migrations in lib/db/migrations. It must not connect to a database.
 */
console.error("Refusing legacy migration script: use lib/db/migrations/README.md after a verified backup.");
process.exitCode = 1;
