import { Router } from 'express';
import type { AppServices } from '../app.js';
import { authRoutes } from './auth-routes.js';
import { categoryRoutes } from './category-routes.js';
import { employeeRoutes } from './employee-routes.js';
import { productRoutes } from './product-routes.js';
import { statsRoutes } from './stats-routes.js';
import { stockMovementRoutes } from './stock-movement-routes.js';

/** Every API resource router, mounted under /api after the rate limits and authentication. */
export function apiRoutes(services: AppServices): Router {
  const router = Router();
  router.use(authRoutes(services));
  router.use(employeeRoutes(services));
  router.use(categoryRoutes(services));
  router.use(productRoutes(services));
  router.use(statsRoutes(services));
  router.use(stockMovementRoutes(services));
  return router;
}
