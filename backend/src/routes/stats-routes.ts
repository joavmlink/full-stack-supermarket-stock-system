import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createStatsController } from '../controllers/stats-controller.js';
import { defineRoute } from '../lib/routing.js';
import { signedIn } from '../middlewares/auth.js';

export function statsRoutes(services: AppServices): Router {
  const router = Router();
  defineRoute(router, '/stats', { get: [...signedIn, createStatsController(services).get] });
  return router;
}
