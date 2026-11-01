import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { sendPage } from '../lib/pagination.js';
import { sendCreated } from '../lib/routing.js';
import { idParam, parseInput } from '../lib/validation.js';
import { currentUser } from '../middlewares/auth.js';
import { createStockMovement, getStockMovement, listStockMovements } from '../models/movement-model.js';
import { StockMovementListQuerySchema, type StockMovementCreate } from '../schemas/movement-schemas.js';

export function createStockMovementController(services: AppServices) {
  const { pool } = services;

  const list: RequestHandler = async (req, res) => {
    const query = parseInput(StockMovementListQuerySchema, req.query, 'query');
    const page = await listStockMovements(pool, query, currentUser(res));
    sendPage(req, res, page, query);
  };

  const get: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await getStockMovement(pool, id, currentUser(res)));
  };

  const create: RequestHandler = async (req, res) => {
    sendCreated(req, res, await createStockMovement(pool, req.body as StockMovementCreate, currentUser(res)));
  };

  return { list, get, create };
}
