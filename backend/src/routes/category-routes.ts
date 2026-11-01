import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createCategoryController } from '../controllers/category-controller.js';
import { defineRoute } from '../lib/routing.js';
import { adminOnly, signedIn } from '../middlewares/auth.js';
import { validateBody } from '../middlewares/validation.js';
import { CategoryCreateSchema, CategoryUpdateSchema } from '../schemas/category-schemas.js';

/** Everyone signed in reads categories; only admins change them. */
export function categoryRoutes(services: AppServices): Router {
  const router = Router();
  const controller = createCategoryController(services);

  defineRoute(router, '/categories', {
    get: [...signedIn, controller.list],
    post: [...adminOnly, validateBody(CategoryCreateSchema), controller.create],
  });
  defineRoute(router, '/categories/:id', {
    get: [...signedIn, controller.get],
    patch: [...adminOnly, validateBody(CategoryUpdateSchema), controller.update],
    delete: [...adminOnly, controller.remove],
  });
  return router;
}
