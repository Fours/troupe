// Runs after tsc: writes each backend's table SQL next to its built module, so it ships in dist/
// for people who manage migrations themselves. The SQL's one source is the backend's constant.
import { writeFileSync } from 'node:fs';
import { SQLITE_SCHEMA } from '../src/node/sqlite/schema.ts';

writeFileSync(new URL('../dist/node/sqlite/schema.sql', import.meta.url), SQLITE_SCHEMA);
