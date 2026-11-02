// `npm run test:concurrency -w backend`: the concurrency scenarios on a real Postgres, which they
// change freely. The target must be a database made for this: a Neon branch created with
// "Schema only". See guard.ts for what protects any other database.
import { claimTestDatabase, describeTarget, readTargetUrl } from './guard.js';
import { defineConcurrencyScenarios } from './scenarios.js';

defineConcurrencyScenarios({
  instances: 2,
  poolSize: 5,
  realSessions: true,
  // A request takes about a second from a machine far from the database.
  raceStepMs: 200,
  open: async () => {
    const connectionString = readTargetUrl();
    console.log(`Target: Postgres at ${describeTarget(connectionString)}`);
    await claimTestDatabase(connectionString);
    return { connectionString, close: async () => {} };
  },
});
