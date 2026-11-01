import { useEffect, useRef, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useStore } from 'zustand';
import { MAX_ITEMS_PER_MOVEMENT } from '../api/limits';
import type { FormMovementType, StockMovement } from '../api/types';
import { Button } from '../components/Button';
import { LinkButton, Notice, PageHeader, WriteStatus, textLinkClass } from '../components/feedback';
import { SelectField, TextField } from '../components/fields';
import { ProductPicker } from '../components/ProductPicker';
import { useDocumentTitle } from '../hooks/use-document-title';
import { FORM_MOVEMENT_TYPES, MOVEMENT_TYPE_LABELS } from '../lib/movement-types';
import { formatCount, formatDelta, formatInteger, formatUnits } from '../lib/numbers';
import { movementFormStore, searchProducts } from '../stores';
import { movementSubmission } from '../stores/movement-form-store';

/** One form, one type, any number of products: a sale subtracts from every line, a restock adds. */
export default function StockMovementFormPage() {
  useDocumentTitle('Record movement');
  const recorded = useStore(movementFormStore, (state) => state.recorded);

  // A confirmation shown on an earlier visit starts a blank form; one that landed while the
  // user was elsewhere has not been seen yet, so it stays. (A ref: StrictMode runs this twice.)
  const entering = useRef(true);
  useEffect(() => {
    const form = movementFormStore.getState();
    if (entering.current && form.recordedShown) form.startOver();
    else if (form.recorded !== null) form.markRecordedShown();
    entering.current = false;
  }, [recorded]);

  return (
    <section className="max-w-3xl" data-testid="movement-form-page">
      <PageHeader title="Record movement">
        <p className="text-slate-600">A sale takes units out of stock; a restock adds them.</p>
      </PageHeader>
      {recorded === null ? <MovementForm /> : <Recorded movement={recorded} />}
    </section>
  );
}

function MovementForm() {
  const type = useStore(movementFormStore, (state) => state.type);
  const lines = useStore(movementFormStore, (state) => state.lines);
  const errors = useStore(movementFormStore, (state) => state.errors);
  const submission = useStore(movementFormStore, movementSubmission);
  const form = movementFormStore.getState();
  const pending = submission.status === 'pending';

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void form.submit();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="movement-form">
      <fieldset disabled={pending} className="space-y-4">
        <SelectField
          label="Type"
          value={type}
          onChange={(event) => form.setType(event.target.value as FormMovementType)}
          className="max-w-xs"
          testId="movement-type"
        >
          {FORM_MOVEMENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {MOVEMENT_TYPE_LABELS[value].one}
            </option>
          ))}
        </SelectField>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Products</legend>
          <ol className="space-y-3">
            {lines.map((line, index) => {
              const lineErrors = errors?.lines[line.key];
              return (
                <li
                  key={line.key}
                  className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_9rem_auto] sm:items-start"
                  data-testid="movement-line"
                >
                  <ProductPicker
                    label={`Product ${index + 1}`}
                    value={line.product}
                    onChange={(product) => form.setProduct(line.key, product)}
                    search={searchProducts}
                    error={lineErrors?.product}
                    disabled={pending}
                    testId="line-product"
                  />
                  <TextField
                    label="Quantity"
                    inputMode="numeric"
                    autoComplete="off"
                    value={line.quantity}
                    onChange={(event) => form.setQuantity(line.key, event.target.value)}
                    error={lineErrors?.quantity}
                    testId="line-quantity"
                  />
                  <Button
                    variant="secondary"
                    className="sm:mt-6"
                    disabled={lines.length === 1}
                    onClick={() => form.removeLine(line.key)}
                    aria-label={`Remove product ${index + 1}`}
                    data-testid="remove-line"
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ol>
          <Button
            variant="secondary"
            onClick={() => form.addLine()}
            disabled={lines.length >= MAX_ITEMS_PER_MOVEMENT}
            data-testid="add-line"
          >
            Add product
          </Button>
          {lines.length >= MAX_ITEMS_PER_MOVEMENT && (
            <p className="text-sm text-slate-600">One movement holds at most {MAX_ITEMS_PER_MOVEMENT} products.</p>
          )}
        </fieldset>
      </fieldset>

      <WriteStatus state={submission} pendingLabel="Recording…" onRetry={() => void form.retry()} testId="movement-status" />

      <div className="border-t border-slate-200 pt-4">
        <Button type="submit" pending={pending} data-testid="submit-movement">
          Record {MOVEMENT_TYPE_LABELS[type].one.toLowerCase()}
        </Button>
      </div>
    </form>
  );
}

function Recorded({ movement }: { movement: StockMovement }) {
  const units = movement.items.reduce((total, item) => total + Math.abs(item.delta), 0);
  return (
    <div className="space-y-4" data-testid="movement-recorded">
      <Notice tone="success" role="status">
        <p className="font-semibold">
          {MOVEMENT_TYPE_LABELS[movement.type].one} recorded: {formatUnits(units)} across {formatCount(movement.items.length, 'product')}.
        </p>
      </Notice>
      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        {movement.items.map((item, index) => (
          <li key={index} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span>
              <span className="font-medium">{item.product.name}</span> <span className="text-slate-600">— {item.product.brand}</span>
            </span>
            <span className="text-sm">
              <span className="font-semibold">{formatDelta(item.delta)}</span>{' '}
              <span className="text-slate-600">· {formatInteger(item.quantityAfter)} left</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => movementFormStore.getState().startOver()} data-testid="record-another">
          Record another
        </Button>
        <LinkButton variant="secondary" to={`/stock-movements/${movement.id}`}>
          View details
        </LinkButton>
        <Link to="/" className={`${textLinkClass} self-center`}>
          Back to products
        </Link>
      </div>
    </div>
  );
}
