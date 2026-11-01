import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { CATEGORY_NAME_MAX } from '../api/limits';
import type { Category } from '../api/types';
import { Button } from '../components/Button';
import { ConfirmButton, PageHeader, WriteStatus } from '../components/feedback';
import { TextField } from '../components/fields';
import { ListStates } from '../components/PagedListView';
import { useDocumentTitle } from '../hooks/use-document-title';
import { useScreenScope } from '../hooks/use-screen-scope';
import { normalizeText, validateCategoryName } from '../lib/forms';
import { categoriesStore } from '../stores';
import { NEW_CATEGORY } from '../stores/categories-store';
import { IDLE } from '../stores/shared';

/** Admins only. A category with products cannot be deleted (the API answers 409). */
export default function CategoriesPage() {
  useDocumentTitle('Categories');
  const items = useStore(categoriesStore, (state) => state.items);
  const status = useStore(categoriesStore, (state) => state.status);
  const error = useStore(categoriesStore, (state) => state.error);

  useEffect(() => {
    void categoriesStore.getState().load();
  }, []);

  return (
    <section className="max-w-2xl" data-testid="categories-page">
      <PageHeader title="Categories" />
      <NewCategoryForm />
      <ListStates
        items={items}
        status={status}
        error={error}
        errorText="Could not load the categories."
        onRetry={() => void categoriesStore.getState().load()}
        empty="No categories yet. Add the first one above."
      >
        {(categories) => (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="category-list">
            {categories.map((category) => (
              <CategoryRow key={category.id} category={category} />
            ))}
          </ul>
        )}
      </ListStates>
    </section>
  );
}

function NewCategoryForm() {
  const write = useStore(categoriesStore, (state) => state.writes[NEW_CATEGORY]);
  const state = write?.state ?? IDLE;
  const scope = useScreenScope();
  // A create still unfinished from an earlier visit shows the name it sent.
  const [name, setName] = useState(() => (typeof write?.input === 'string' && state.status !== 'succeeded' ? write.input : ''));
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  async function create() {
    const problem = validateCategoryName(name);
    setError(problem);
    if (problem !== undefined) return;
    const screen = scope.current;
    const outcome = await categoriesStore.getState().create(normalizeText(name));
    if (screen.active && outcome.kind === 'succeeded') {
      setName('');
      input.current?.focus();
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void create();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="mb-6 space-y-3 rounded-xl border border-slate-200 bg-white p-4" data-testid="new-category-form">
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          ref={input}
          label="New category"
          value={name}
          maxLength={CATEGORY_NAME_MAX}
          disabled={state.status === 'pending'}
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
            categoriesStore.getState().dismiss(NEW_CATEGORY);
          }}
          error={error}
          className="min-w-0 flex-1"
          testId="new-category-name"
        />
        <Button type="submit" pending={state.status === 'pending'} data-testid="add-category">
          Add
        </Button>
      </div>
      <WriteStatus state={state} onRetry={() => void categoriesStore.getState().retry(NEW_CATEGORY)} testId="new-category-status" />
    </form>
  );
}

function CategoryRow({ category }: { category: Category }) {
  // The kind of write (rename or remove) lives in the store, so it is right even after the page reopens.
  const write = useStore(categoriesStore, (state) => state.writes[category.id]);
  const state = write?.state ?? IDLE;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [error, setError] = useState<string>();
  const pending = state.status === 'pending';
  const removing = write?.kind === 'remove';

  async function rename() {
    const problem = validateCategoryName(name);
    setError(problem);
    if (problem !== undefined) return;
    const outcome = await categoriesStore.getState().rename(category.id, normalizeText(name));
    if (outcome.kind === 'succeeded') setEditing(false);
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void rename();
  };

  return (
    <li className="space-y-2 px-4 py-3" data-testid="category-row">
      {editing ? (
        <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-2">
          <TextField
            label={`New name for ${category.name}`}
            value={name}
            maxLength={CATEGORY_NAME_MAX}
            disabled={pending}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            error={error}
            className="min-w-0 flex-1"
            testId="category-name-input"
          />
          <Button type="submit" pending={pending} data-testid="save-category">
            Save
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setEditing(false);
              setError(undefined);
              categoriesStore.getState().dismiss(category.id);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium break-words" data-testid="category-name">
            {category.name}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                categoriesStore.getState().dismiss(category.id);
                // Start from the name as it is now (another admin may have renamed it).
                setName(category.name);
                setEditing(true);
              }}
              data-testid="rename-category"
            >
              Rename<span className="sr-only"> {category.name}</span>
            </Button>
            <ConfirmButton
              label="Delete"
              question={`Delete ${category.name}?`}
              pending={pending && removing}
              disabled={pending}
              onConfirm={() => void categoriesStore.getState().remove(category.id)}
              testId="delete-category"
            />
          </div>
        </div>
      )}
      <WriteStatus
        state={state}
        pendingLabel={removing ? 'Deleting…' : 'Saving…'}
        onRetry={() => void categoriesStore.getState().retry(category.id)}
        testId="category-status"
      />
    </li>
  );
}
