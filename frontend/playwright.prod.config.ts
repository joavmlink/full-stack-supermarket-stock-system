// The same specs against the production build, served like Vercel serves it:
// vite preview with the vercel.json headers and /api proxied to the API.
import { API_ORIGIN, apiServer, e2eConfig, HOST, PREVIEW_PORT } from './playwright.shared';

const baseURL = `http://${HOST}:${PREVIEW_PORT}`;

export default e2eConfig('prod', {
  baseURL,
  // Test data goes straight to the API; the pages call the relative /api through the proxy.
  apiURL: `${API_ORIGIN}/api`,
  webServer: [
    apiServer,
    {
      command: `npm run build && npm run preview -- --host ${HOST} --port ${PREVIEW_PORT}`,
      url: baseURL,
      env: { API_PROXY_TARGET: API_ORIGIN },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
