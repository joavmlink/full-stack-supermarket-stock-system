import { useEffect } from 'react';
import { Link } from 'react-router';
import { LinkButton, PageHeader, textLinkClass } from '../components/feedback';
import { PagedListView } from '../components/PagedListView';
import { useDocumentTitle } from '../hooks/use-document-title';
import { formatDateTime } from '../lib/dates';
import { employeesStore } from '../stores';

/** Admins only. Administrators are not listed: they are created with the CLI. */
export default function EmployeesPage() {
  useDocumentTitle('Employees');

  useEffect(() => {
    void employeesStore.getState().load({});
  }, []);

  return (
    <section className="max-w-3xl" data-testid="employees-page">
      <PageHeader
        title="Employees"
        actions={
          <LinkButton to="/employees/new" data-testid="new-employee">
            New employee
          </LinkButton>
        }
      />
      <PagedListView
        store={employeesStore}
        onRetry={() => void employeesStore.getState().load({})}
        errorText="Could not load the employees."
        empty={
          <>
            No employees yet.{' '}
            <Link to="/employees/new" className={textLinkClass}>
              Add the first one
            </Link>
            .
          </>
        }
      >
        {(items) => (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="employee-list">
            {items.map((employee) => (
              <li key={employee.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-testid="employee-row">
                <div className="min-w-0">
                  <p className="font-medium break-words" data-testid="employee-name">
                    {employee.fullName}
                  </p>
                  <p className="text-sm break-all text-slate-600">{employee.email}</p>
                  <p className="text-sm text-slate-500">Since {formatDateTime(employee.createdAt)}</p>
                </div>
                <Link to={`/employees/${employee.id}/edit`} className={textLinkClass} data-testid="edit-employee">
                  Edit<span className="sr-only"> {employee.fullName}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PagedListView>
    </section>
  );
}
