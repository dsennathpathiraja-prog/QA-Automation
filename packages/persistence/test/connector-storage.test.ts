import { connectorStorageContract } from '@qa/testing';
import { PgApprovedHostRepository, PgConnectorRepository, PgTestRequestQueue } from '../src';
import { freshDb } from './helpers';

connectorStorageContract('postgres (PGlite)', async () => {
  const { db } = await freshDb();
  return { connectors: new PgConnectorRepository(db), tests: new PgTestRequestQueue(db), hosts: new PgApprovedHostRepository(db) };
});
