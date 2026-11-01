import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { sendPage } from '../lib/pagination.js';
import { sendCreated } from '../lib/routing.js';
import { idParam, parseInput } from '../lib/validation.js';
import { createCategory, deleteCategory, getCategory, listCategories, renameCategory } from '../models/category-model.js';
import type { CategoryCreate, CategoryUpdate } from '../schemas/category-schemas.js';
import { PageQuerySchema } from '../schemas/common-schemas.js';

export function createCategoryController(services: AppServices) {
  const { pool } = services;

  const list: RequestHandler = async (req, res) => {
    const query = parseInput(PageQuerySchema, req.query, 'query');
    const page = await listCategories(pool, query);
    sendPage(req, res, page, query);
  };

  const get: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await getCategory(pool, id));
  };

  const create: RequestHandler = async (req, res) => {
    sendCreated(req, res, await createCategory(pool, req.body as CategoryCreate));
  };

  const update: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await renameCategory(pool, id, (req.body as CategoryUpdate).name));
  };

  const remove: RequestHandler = async (req, res) => {
    const id = idParam(req);
    await deleteCategory(pool, id);
    res.status(204).end();
  };

  return { list, get, create, update, remove };
}
