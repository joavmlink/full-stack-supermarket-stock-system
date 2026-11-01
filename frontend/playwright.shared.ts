import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import type { E2EOptions, Target } from './tests/e2e/fixtures';

// 127.0.0.1, never "localhost": on Windows Vite listens only on ::1 by default,
// and a browser resolving "localhost" to 127.0.0.1 would hang until the timeout.
export const HOST = '127.0.0.1';
// Dedicated ports, so the tests never reuse a development server (3000, 5173, 4173).
const API_PORT = 3100;
export const DEV_PORT = 5174;
export const PREVIEW_PORT = 4174;
export const API_ORIGIN = `http://${HOST}:${API_PORT}`;

type WebServer = Extract<PlaywrightTestConfig['webServer'], unknown[]>[number];

/** The real API on an in-memory database with fake users (backend/tests/e2e-server.ts). */
export const apiServer: WebServer = {
  command: 'npm run e2e-server',
  cwd: fileURLToPath(new URL('../backend', import.meta.url)),
  url: `${API_ORIGIN}/api/health`,
  env: { E2E_API_PORT: String(API_PORT), E2E_ORIGINS: `http://${HOST}:${DEV_PORT}` },
  reuseExistingServer: false,
  timeout: 60_000,
};

/** One worker: every test resets the shared database. Each target writes to its own folder. */
export function e2eConfig(target: Target, config: { baseURL: string; apiURL: string; testMatch?: string; webServer?: WebServer[] }) {
  return defineConfig<E2EOptions>({
    testDir: 'tests/e2e',
    testMatch: config.testMatch ?? '**/*.spec.ts',
    // Playwright empties outputDir when it starts: a folder per target keeps each run's traces.
    outputDir: `test-results/${target}`,
    workers: 1,
    fullyParallel: false,
    forbidOnly: process.env.CI !== undefined,
    retries: 0,
    reporter: 'list',
    timeout: 30_000,
    use: {
      ...devices['Desktop Chrome'],
      baseURL: config.baseURL,
      target,
      apiURL: config.apiURL,
      // The remote smoke test types real credentials: keep them out of traces and screenshots.
      trace: target === 'remote' ? 'off' : 'retain-on-failure',
      screenshot: target === 'remote' ? 'off' : 'only-on-failure',
    },
    webServer: config.webServer,
  });
}
