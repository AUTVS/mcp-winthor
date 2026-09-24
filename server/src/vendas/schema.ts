/**
 * Reexporta o esquema meta v2 como esquema principal.
 * O v1 legado vive em `schema-v1.ts` para migração.
 */
export { DDL_META as DDL, MIGRACOES, SCHEMA_VERSION } from './schema-meta';
