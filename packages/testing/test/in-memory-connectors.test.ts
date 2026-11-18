import { connectorStorageContract, InMemoryConnectorRepository, InMemoryHostRepository, InMemoryTestQueue } from '../src';

connectorStorageContract('in-memory', async () => ({ connectors: new InMemoryConnectorRepository(), tests: new InMemoryTestQueue(), hosts: new InMemoryHostRepository() }));
