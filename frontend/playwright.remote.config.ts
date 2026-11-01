// Only the smoke test, read-only, against a deployed URL:
//   $env:E2E_BASE_URL = "https://..."; $env:E2E_EMAIL = "..."; $env:E2E_PASSWORD = "..."
//   npm run test:e2e:remote -w frontend
import { e2eConfig } from './playwright.shared';

const baseURL = process.env.E2E_BASE_URL?.replace(/\/+$/, '');
if (baseURL === undefined || baseURL === '') {
  throw new Error('Set E2E_BASE_URL to the deployed URL (for example https://your-app.vercel.app).');
}

export default e2eConfig('remote', {
  baseURL,
  apiURL: `${baseURL}/api`,
  testMatch: 'smoke.spec.ts',
});
