/** Public surface of the AI module. Import from `core/ai` instead of deep
 *  paths so refactors stay contained. */
export * from './types';
export * from './providers';
export { generateSQL, fetchModels, validateConnection, testConnection, parseSqlResponse } from './client';
export { buildSchemaContext } from './schemaContext';
