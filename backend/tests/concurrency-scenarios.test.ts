// The concurrency scenarios on PGlite: one session serializes the requests, so this
// proves their outcomes, not the locks, and keeps the suite working between runs of
// `npm run test:concurrency` on a real Postgres.
import { startLocalDatabase } from '../src/db/local.js';
import { defineConcurrencyScenarios } from './concurrency/scenarios.js';

defineConcurrencyScenarios({
  instances: 1,
  poolSize: 1,
  realSessions: false,
  raceStepMs: 5,
  open: async () => {
    const local = await startLocalDatabase();
    return { connectionString: local.connectionString, close: local.close };
  },
});
