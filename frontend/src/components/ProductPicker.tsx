import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../api/errors';
import type { Page, Product } from '../api/types';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import type { ProductOption } from '../lib/forms';
import { formatInteger } from '../lib/numbers';
import { FieldFrame } from './fields';

const SEARCH_DELAY_MS = 250;

const describe = (product: ProductOption) => `${product.name} — ${product.brand}`;

type Results = { status: 'loading' } | { status: 'loaded'; options: ProductOption[] } | { status: 'error'; message: string };

/**
 * A combobox (WAI-ARIA 1.2 pattern, list autocomplete) that searches products
 * by name or brand as the user types. Arrow keys move through the options,
 * Enter picks one, Escape closes the list. Searching starts only once the list
 * opens, after a short pause, so StrictMode's double mount sends nothing twice.
 */
export function ProductPicker({
  label,
  value,
  onChange,
  search,
  error,
  disabled = false,
  testId,
}: {
  label: string;
  value: ProductOption | null;
  onChange: (product: ProductOption | null) => void;
  search: (query: string) => Promise<Page<Product>>;
  error?: string | undefined;
  disabled?: boolean;
  testId: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [results, setResults] = useState<Results>({ status: 'loading' });
  const debouncedQuery = useDebouncedValue(query, SEARCH_DELAY_MS);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setResults({ status: 'loading' });
    search(debouncedQuery).then(
      (page) => {
        if (!current) return;
        setResults({ status: 'loaded', options: page.items });
        setActive(-1);
      },
      (failure: unknown) => {
        if (current) setResults({ status: 'error', message: errorMessage(failure) });
      },
    );
    // Only the latest search may show its results.
    return () => {
      current = false;
    };
  }, [open, debouncedQuery, search]);

  const options = results.status === 'loaded' ? results.options : [];

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const pick = (option: ProductOption) => {
    onChange(option);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + options.length) % options.length);
    } else if (event.key === 'Enter' && open) {
      const option = options[active];
      if (option !== undefined) {
        event.preventDefault();
        pick(option);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  };

  const activeOption = open ? options[active] : undefined;

  return (
    <FieldFrame
      label={label}
      error={error}
      className="relative"
      hint={value !== null && !open ? <span data-testid={`${testId}-stock`}>{formatInteger(value.quantity)} in stock</span> : undefined}
    >
      {(control) => (
        <>
          <input
            {...control}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={activeOption === undefined ? undefined : `${id}-option-${activeOption.id}`}
            autoComplete="off"
            placeholder="Search by name or brand"
            disabled={disabled}
            data-testid={testId}
            value={open ? query : value === null ? '' : describe(value)}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={close}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
          />
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label}: results`}
        hidden={!open}
        className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
      >
        {results.status === 'loading' && <li className="px-3 py-2 text-sm text-slate-600">Searching…</li>}
        {results.status === 'error' && <li className="px-3 py-2 text-sm text-red-700">{results.message}</li>}
        {results.status === 'loaded' && options.length === 0 && (
          <li className="px-3 py-2 text-sm text-slate-600">No products match.</li>
        )}
        {options.map((option, index) => (
          <li
            key={option.id}
            id={`${id}-option-${option.id}`}
            role="option"
            aria-selected={index === active}
            data-testid="product-option"
            // Keep the focus in the input, so the blur does not close the list before the click.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(option)}
            className={`cursor-pointer px-3 py-2 ${index === active ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
          >
            <span className="block font-medium">{option.name}</span>
            <span className="block text-sm text-slate-600">
              {option.brand} · {formatInteger(option.quantity)} in stock
            </span>
          </li>
        ))}
      </ul>
        </>
      )}
    </FieldFrame>
  );
}
