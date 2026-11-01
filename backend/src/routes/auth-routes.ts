import { Router } from 'express';
import type { AppServices } from '../app.js';
import { createAuthController } from '../controllers/auth-controller.js';
import { defineRoute } from '../lib/routing.js';
import { sha256Hex } from '../lib/hash.js';
import { failureRateLimit } from '../middlewares/rate-limit.js';
import { validateBody } from '../middlewares/validation.js';
import { LoginBodySchema, type LoginBody } from '../schemas/user-schemas.js';

export function authRoutes(services: AppServices): Router {
  const router = Router();
  const controller = createAuthController(services);
  const { pool, logger, config } = services;
  const { loginWindowMs: windowMs, loginMax, loginAccountMax } = config.rateLimit;
  const limits = { pool, logger, windowMs };

  defineRoute(router, '/auth/login', {
    post: [
      // Failed logins per client IP, then per account (emails are hashed, never stored).
      failureRateLimit({ name: 'login-ip', limit: loginMax, ...limits }),
      validateBody(LoginBodySchema),
      failureRateLimit({
        name: 'login-account',
        limit: loginAccountMax,
        key: (req) => sha256Hex((req.body as LoginBody).email),
        ...limits,
      }),
      controller.login,
    ],
  });
  defineRoute(router, '/auth/logout', { post: [controller.logout] });
  defineRoute(router, '/auth/session', { get: [controller.session] });
  return router;
}
