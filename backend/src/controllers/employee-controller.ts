import type { RequestHandler } from 'express';
import type { AppServices } from '../app.js';
import { sendPage } from '../lib/pagination.js';
import { acceptNewPassword } from '../lib/password-policy.js';
import { sendCreated } from '../lib/routing.js';
import { idParam, parseInput } from '../lib/validation.js';
import { createEmployee, deleteEmployee, getEmployee, listEmployees, updateEmployee } from '../models/user-model.js';
import { PageQuerySchema } from '../schemas/common-schemas.js';
import type { EmployeeCreate, EmployeeUpdate } from '../schemas/user-schemas.js';

export function createEmployeeController(services: AppServices) {
  const { pool } = services;

  const list: RequestHandler = async (req, res) => {
    const query = parseInput(PageQuerySchema, req.query, 'query');
    const page = await listEmployees(pool, query);
    sendPage(req, res, page, query);
  };

  const get: RequestHandler = async (req, res) => {
    const id = idParam(req);
    res.json(await getEmployee(pool, id));
  };

  const create: RequestHandler = async (req, res) => {
    const body = req.body as EmployeeCreate;
    const result = await createEmployee(pool, {
      id: body.id,
      fullName: body.fullName,
      email: body.email,
      password: body.password,
      passwordHash: await acceptNewPassword(body.password, body, services),
    });
    sendCreated(req, res, result);
  };

  const update: RequestHandler = async (req, res) => {
    const id = idParam(req);
    const body = req.body as EmployeeUpdate;
    let passwordHash: string | undefined;
    if (body.password !== undefined) {
      // The context words are the new values when they change, otherwise the stored ones.
      const current = await getEmployee(pool, id);
      passwordHash = await acceptNewPassword(
        body.password,
        { email: body.email ?? current.email, fullName: body.fullName ?? current.fullName },
        services,
      );
    }
    res.json(await updateEmployee(pool, id, { fullName: body.fullName, email: body.email, passwordHash }));
  };

  const remove: RequestHandler = async (req, res) => {
    const id = idParam(req);
    await deleteEmployee(pool, id);
    res.status(204).end();
  };

  return { list, get, create, update, remove };
}
