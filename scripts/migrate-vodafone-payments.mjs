#!/usr/bin/env node
/**
 * RETIRED — this former helper could seed a wallet and fixed price. Payments
 * remain disabled by default and schema changes must use reviewed migrations
 * after a verified backup and approved deployment window.
 */
console.error("Refusing legacy payment migration: use lib/db/migrations/README.md after a verified backup.");
process.exitCode = 1;
