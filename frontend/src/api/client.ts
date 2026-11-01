import { createHttpClient } from './http';

const baseUrl = import.meta.env.VITE_API_URL;
if (!baseUrl) throw new Error('VITE_API_URL is not set (see frontend/.env.example).');

/** The app's only HTTP client (it reads VITE_API_URL, so it only works inside Vite). */
export const apiClient = createHttpClient({ baseUrl });
