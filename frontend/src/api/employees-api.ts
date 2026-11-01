import type { HttpClient } from './http';
import { deleteResource, getPage, resourcePath } from './page';
import type { EmployeeFields, Page, User } from './types';

/** Admin only; the API never returns admin accounts here. */
export interface EmployeesApi {
  list(params: { before?: string; limit?: number }): Promise<Page<User>>;
  get(id: string): Promise<User>;
  create(id: string, fields: EmployeeFields): Promise<User>;
  /** A new password signs the employee out everywhere. */
  update(id: string, changes: Partial<EmployeeFields>): Promise<User>;
  remove(id: string): Promise<void>;
}

const at = (id: string) => resourcePath('/employees', id);

export function createEmployeesApi(http: HttpClient): EmployeesApi {
  return {
    list: (params) => getPage<User>(http, '/employees', { ...params }),
    get: (id) => http.request<User>('GET', at(id)),
    create: (id, fields) => http.request<User>('POST', '/employees', { body: { id, ...fields } }),
    update: (id, changes) => http.request<User>('PATCH', at(id), { body: changes }),
    remove: (id) => deleteResource(http, at(id), 'EMPLOYEE_NOT_FOUND'),
  };
}
