import { Router } from 'express';
import { getHealth } from '../controllers/health-controller.js';
import { defineRoute } from '../lib/routing.js';

export function healthRoutes(): Router {
  const router = Router();
  defineRoute(router, '/health', { get: [getHealth] });
  return router;
}
