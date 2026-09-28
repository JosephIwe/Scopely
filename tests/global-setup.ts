// Creates a throwaway database on the local Postgres server, migrates it, and drops it after
// the run. TEST_DATABASE_ADMIN_URL must point at a server where the role can CREATE DATABASE.
// Tests never touch DATABASE_URL.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext { dbUrl: string; appRole: string }
}

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://scopely:scopely@localhost:5432/postgres';

export default async function setup(project: TestProject) {
  const name = `scopely_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const first = await migrate(client);
  const second = await migrate(client); // idempotency: a re-run applies nothing
  // A non-owner role, as the application would connect, so row-level security applies to it.
  const appRole = `${name}_app`;
  await client.query(`CREATE ROLE ${appRole} NOLOGIN`);
  await client.query(`GRANT USAGE ON SCHEMA scopely TO ${appRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scopely TO ${appRole}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA scopely TO ${appRole}`);
  await client.end();
  if (second.applied.length !== 0) throw new Error('migrations re-applied on second run');
  if (first.applied.length === 0) throw new Error('no migrations applied');
  project.provide('dbUrl', url.toString());
  project.provide('appRole', appRole);
  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.end();
  };
}
