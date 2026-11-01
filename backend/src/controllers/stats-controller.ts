import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { currentUser } from '../middlewares/auth.js';
import { getStats } from '../models/stats-model.js';

export function createStatsController(services: AppServices) {
  const get: RequestHandler = async (_req, res) => {
    res.json(await getStats(services.pool, currentUser(res)));
  };
  return { get };
}
