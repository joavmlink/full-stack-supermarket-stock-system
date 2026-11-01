import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createProductController } from '../controllers/product-controller.js';
import { defineRoute } from '../lib/routing.js';
import { adminOnly, signedIn } from '../middlewares/auth.js';
import { validateBody } from '../middlewares/validation.js';
import { ProductCreateSchema, ProductUpdateSchema } from '../schemas/product-schemas.js';

/** Everyone signed in reads products; only admins create, edit or delete them. */
export function productRoutes(services: AppServices): Router {
  const router = Router();
  const controller = createProductController(services);

  defineRoute(router, '/products', {
    get: [...signedIn, controller.list],
    post: [...adminOnly, validateBody(ProductCreateSchema), controller.create],
  });
  defineRoute(router, '/products/:id', {
    get: [...signedIn, controller.get],
    patch: [...adminOnly, validateBody(ProductUpdateSchema), controller.update],
    delete: [...adminOnly, controller.remove],
  });
  return router;
}
