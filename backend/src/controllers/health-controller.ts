import type { RequestHandler } from 'express';

/** Liveness only: it never touches the database, so health checks don't keep Neon awake. */
export const getHealth: RequestHandler = (_req, res) => {
  res.json({ status: 'ok' });
};
