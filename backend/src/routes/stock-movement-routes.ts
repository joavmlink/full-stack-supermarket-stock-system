import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createStockMovementController } from '../controllers/stock-movement-controller.js';
import { defineRoute } from '../lib/routing.js';
import { signedIn } from '../middlewares/auth.js';
import { validateBody } from '../middlewares/validation.js';
import { StockMovementCreateSchema } from '../schemas/movement-schemas.js';

/**
 * Everyone signed in records sales and restocks. Admins read every movement; an
 * employee reads only their own (anyone else's answers 404). Movements are never edited or deleted.
 */
export function stockMovementRoutes(services: AppServices): Router {
  const router = Router();
  const controller = createStockMovementController(services);

  defineRoute(router, '/stock-movements', {
    get: [...signedIn, controller.list],
    post: [...signedIn, validateBody(StockMovementCreateSchema), controller.create],
  });
  defineRoute(router, '/stock-movements/:id', {
    get: [...signedIn, controller.get],
  });
  return router;
}
