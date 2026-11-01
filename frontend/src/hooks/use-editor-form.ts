import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useStore } from 'zustand';
import { fieldErrorsFromApi, type FieldErrors, type FormResult } from '../lib/forms';
import { editorWrite, type EditorStore } from '../stores/editor-store';

/**
 * The wiring every editor form shares: field values and errors (its own and
 * the API's), save and delete with their Retry, and the navigation to
 * `doneTo` when one of them lands while the form is open, whichever visit
 * started it: a form never stays open on a write that is done, where sending it
 * again would repeat it.
 */
export function useEditorForm<T, F, K extends string>(
  store: EditorStore<T, F>,
  options: {
    /** The values the form starts with (an unfinished save's, the stored item's, or blank). */
    initial: () => Record<K, string>;
    validate: (values: Record<K, string>) => FormResult<F, K>;
    labels: Record<K, string>;
    /** Conflict codes that belong to one field (EMAIL_TAKEN → email). */
    codeFields?: Partial<Record<string, NoInfer<K>>>;
    doneTo: string;
  },
) {
  const navigate = useNavigate();
  const save = useStore(store, (state) => editorWrite(state, 'save'));
  const remove = useStore(store, (state) => editorWrite(state, 'remove'));
  const [values, setValues] = useState(options.initial);
  const [errors, setErrors] = useState<FieldErrors<K>>({});
  const serverErrors: FieldErrors<K> = save.status === 'rejected' ? fieldErrorsFromApi<K>(save, options.labels, options.codeFields) : {};

  const done = save.status === 'succeeded' || remove.status === 'succeeded';
  useEffect(() => {
    if (done) void navigate(options.doneTo);
  }, [done, navigate, options.doneTo]);

  return {
    values,
    save,
    remove,
    busy: save.status === 'pending' || remove.status === 'pending',
    explainedOnFields: Object.keys(serverErrors).length > 0,
    errorOf: (field: K): string | undefined => errors[field] ?? serverErrors[field],
    set: (field: K) => (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: undefined }));
    },
    onSubmit(event: FormEvent) {
      event.preventDefault();
      const result = options.validate(values);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors({});
      void store.getState().submit(result.fields);
    },
    retrySave: () => void store.getState().retry('save'),
    deleteItem: () => void store.getState().delete(),
    retryDelete: () => void store.getState().retry('remove'),
  };
}
