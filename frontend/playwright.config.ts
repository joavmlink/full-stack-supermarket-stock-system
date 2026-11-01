// End-to-end tests against the development servers: the real API (in-memory
// database) and Vite, each on a dedicated port.
import { API_ORIGIN, apiServer, DEV_PORT, e2eConfig, HOST } from './playwright.shared';

const baseURL = `http://${HOST}:${DEV_PORT}`;

export default e2eConfig('dev', {
  baseURL,
  apiURL: `${API_ORIGIN}/api`,
  webServer: [
    apiServer,
    {
      command: `npm run dev -- --host ${HOST} --port ${DEV_PORT}`,
      url: baseURL,
      env: { VITE_API_URL: `${API_ORIGIN}/api` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
