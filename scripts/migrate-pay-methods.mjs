#!/usr/bin/env node
/**
 * RETIRED — direct schema writes and implicit payment defaults are unsafe.
 * Payments remain disabled until an authorized operator explicitly enables a
 * configured method after the reviewed migration/backup procedure.
 */
console.error("Refusing legacy payment-method migration: use lib/db/migrations/README.md after a verified backup.");
process.exitCode = 1;
