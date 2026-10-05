// The provider gateway and its capabilities: business discovery (Slice 10) and prospect intelligence (Slice 12). See gateway.ts.
export * from './gateway.js';
export * from './discovery.js';
export * from './prospects.js';
export { EnvSecretResolver, secretEnvName } from './secrets.js';
export { ClayBusinessDiscoveryAdapter } from './clay/adapter.js';
export { ClayProspectAdapter, CLAY_PEOPLE_QUERY, normalizeClayPerson } from './clay/people.js';
export { ClayMcpTransport, RecordedClayTransport, CLAY_MCP_ENDPOINT, type ClayRecording, type ClayTransport } from './clay/transport.js';
export { CLAY_REVENUE_CURRENCY, clayCompanyQuery, clayCountryName, revenueBuckets } from './clay/query.js';
export { normalizeClayCompany, parseLocality, countryCode } from './clay/normalize.js';
