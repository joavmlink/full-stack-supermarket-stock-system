import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { sendPage } from '../lib/pagination.js';
import { sendCreated } from '../lib/routing.js';
import { idParam, parseInput } from '../lib/validation.js';
import { currentUser } from '../middlewares/auth.js';
import { createProduct, deleteProduct, getProduct, listProducts, updateProduct } from '../models/product-model.js';
import { ProductListQuerySchema, type ProductCreate, type ProductUpdate } from '../schemas/product-schemas.js';

export function createProductController(services: AppServices) {
  const { pool } = services;

  const list: RequestHandler = async (req, res) => {
    const query = parseInput(ProductListQuerySchema, req.query, 'query');
    const page = await listProducts(pool, query);
    sendPage(req, res, page, query);
  };

  const get: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await getProduct(pool, id));
  };

  const create: RequestHandler = async (req, res) => {
    sendCreated(req, res, await createProduct(pool, req.body as ProductCreate, currentUser(res)));
  };

  const update: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await updateProduct(pool, id, req.body as ProductUpdate, currentUser(res)));
  };

  const remove: RequestHandler = async (req, res) => {
    const id = idParam(req);
    await deleteProduct(pool, id, currentUser(res));
    res.status(204).end();
  };

  return { list, get, create, update, remove };
}
