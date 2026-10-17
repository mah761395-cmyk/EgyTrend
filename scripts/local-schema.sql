-- RETIRED: this partial bootstrap schema is intentionally non-executable.
-- The source of truth is lib/db/src/schema plus the reviewed paired SQL files
-- under lib/db/migrations. Do not use this file for local, Preview, or
-- production provisioning: it can create a schema that omits current fields
-- and controls. Follow lib/db/migrations/README.md after a verified backup.
\set ON_ERROR_STOP on
\echo 'Refusing retired scripts/local-schema.sql; use lib/db/migrations/README.md.'
SELECT CAST('retired local-schema.sql must not be executed' AS integer);
