import { Link, useParams } from 'react-router';
import { EMAIL_MAX, FULL_NAME_MAX, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../api/limits';
import type { User } from '../api/types';
import { EditorActions } from '../components/EditorActions';
import { EditorGate } from '../components/EditorGate';
import { PageHeader, WriteStatus, textLinkClass } from '../components/feedback';
import { TextField } from '../components/fields';
import { useDocumentTitle } from '../hooks/use-document-title';
import { useEditorForm } from '../hooks/use-editor-form';
import { EMPLOYEE_LABELS, validateEmployeeForm } from '../lib/forms';
import { employeeEditorStore } from '../stores';
import { editorDraft } from '../stores/editor-store';

/** Create (`/employees/new`) and edit (`/employees/:id/edit`); admins only. */
export default function EmployeeFormPage() {
  const { id = null } = useParams();
  const title = id === null ? 'New employee' : 'Edit employee';
  useDocumentTitle(title);

  return (
    <section className="max-w-xl" data-testid="employee-form-page">
      <PageHeader title={title}>
        <Link to="/employees" className={textLinkClass}>
          Back to employees
        </Link>
      </PageHeader>
      <EditorGate
        store={employeeEditorStore}
        id={id}
        errorText="Could not load the employee."
        notFound={
          <div className="space-y-2" data-testid="employee-not-found">
            <p className="font-semibold">Employee not found.</p>
            <p className="text-slate-600">The account may have been deleted.</p>
          </div>
        }
      >
        {(employee) => <EmployeeForm employee={employee} />}
      </EditorGate>
    </section>
  );
}

function EmployeeForm({ employee }: { employee: User | null }) {
  const isNew = employee === null;
  const form = useEditorForm(employeeEditorStore, {
    // A save still unfinished from an earlier visit shows what it sent.
    initial: () =>
      editorDraft(employeeEditorStore.getState()) ?? { fullName: employee?.fullName ?? '', email: employee?.email ?? '', password: '' },
    validate: (values) => validateEmployeeForm(values, isNew ? 'create' : 'edit'),
    labels: EMPLOYEE_LABELS,
    codeFields: { EMAIL_TAKEN: 'email' },
    doneTo: '/employees',
  });
  const { values, save, busy } = form;

  const passwordHint = isNew
    ? `${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. A few unrelated words work well.`
    : `Leave it blank to keep the current password. A new one (${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters) signs the employee out everywhere.`;

  return (
    <form onSubmit={form.onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="employee-form">
      <fieldset disabled={busy} className="space-y-4">
        <TextField
          label="Full name"
          autoComplete="off"
          maxLength={FULL_NAME_MAX}
          value={values.fullName}
          onChange={form.set('fullName')}
          error={form.errorOf('fullName')}
          testId="employee-full-name"
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="off"
          maxLength={EMAIL_MAX}
          value={values.email}
          onChange={form.set('email')}
          error={form.errorOf('email')}
          testId="employee-email"
        />
        <TextField
          label={isNew ? 'Password' : 'New password (optional)'}
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={form.set('password')}
          error={form.errorOf('password')}
          hint={passwordHint}
          testId="employee-password"
        />
      </fieldset>

      <WriteStatus state={save} onRetry={form.retrySave} explainedOnFields={form.explainedOnFields} testId="save-status" />

      <EditorActions form={form} noun="employee" deleteQuestion={isNew ? null : `Delete ${employee.fullName}? Their history stays.`} />
    </form>
  );
}
