import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createEmployeeController } from '../controllers/employee-controller.js';
import { defineRoute } from '../lib/routing.js';
import { adminOnly } from '../middlewares/auth.js';
import { validateBody } from '../middlewares/validation.js';
import { EmployeeCreateSchema, EmployeeUpdateSchema } from '../schemas/user-schemas.js';

/** Employee accounts: admin only. Admin accounts are never reachable here (they answer 404). */
export function employeeRoutes(services: AppServices): Router {
  const router = Router();
  const controller = createEmployeeController(services);

  defineRoute(router, '/employees', {
    get: [...adminOnly, controller.list],
    post: [...adminOnly, validateBody(EmployeeCreateSchema), controller.create],
  });
  defineRoute(router, '/employees/:id', {
    get: [...adminOnly, controller.get],
    patch: [...adminOnly, validateBody(EmployeeUpdateSchema), controller.update],
    delete: [...adminOnly, controller.remove],
  });
  return router;
}
