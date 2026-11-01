import type { WriteState } from '../stores/shared';
import { Button } from './Button';
import { ConfirmButton, WriteStatus } from './feedback';

/** The footer of an editor form: save, and delete once the item exists (`deleteQuestion`). */
export function EditorActions({
  form,
  noun,
  deleteQuestion,
}: {
  form: { save: WriteState; remove: WriteState; busy: boolean; deleteItem(): void; retryDelete(): void };
  noun: 'product' | 'employee';
  deleteQuestion: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <Button type="submit" pending={form.save.status === 'pending'} disabled={form.busy} data-testid={`save-${noun}`}>
          {deleteQuestion === null ? `Create ${noun}` : 'Save changes'}
        </Button>
        {deleteQuestion !== null && (
          <ConfirmButton
            label={`Delete ${noun}`}
            question={deleteQuestion}
            pending={form.remove.status === 'pending'}
            disabled={form.busy}
            onConfirm={form.deleteItem}
            testId={`delete-${noun}`}
          />
        )}
      </div>
      <WriteStatus state={form.remove} pendingLabel="Deleting…" onRetry={form.retryDelete} testId="delete-status" />
    </>
  );
}
