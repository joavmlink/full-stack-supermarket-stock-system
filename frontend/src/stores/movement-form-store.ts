import { createStore } from 'zustand/vanilla';
import { MAX_ITEMS_PER_MOVEMENT } from '../api/limits';
import type { MovementsApi } from '../api/movements-api';
import type { FormMovementType, StockMovement } from '../api/types';
import { stockErrorsFromApi, validateStockForm, type ProductOption, type StockFormErrors, type StockLine } from '../lib/forms';
import type { WriteOutcome } from '../lib/retry';
import { createIdempotencyKey, createWriteTracker, writeOf, type StoreDeps, type WriteState, type Writes } from './shared';

/** The key of the form's one write in `writes`. */
const SUBMISSION = 'movement';

/**
 * The stock form (one type for every line). It lives in a store, so a
 * movement that is still retrying keeps its lines and its state while the
 * user visits other pages.
 */
export interface MovementFormState {
  type: FormMovementType;
  lines: StockLine[];
  errors: StockFormErrors | null;
  writes: Writes;
  /** The movement just recorded (the success screen). */
  recorded: StockMovement | null;
  /** The success screen has been on screen, so the next visit can start blank. */
  recordedShown: boolean;

  setType(type: FormMovementType): void;
  addLine(): void;
  removeLine(key: string): void;
  setProduct(key: string, product: ProductOption | null): void;
  setQuantity(key: string, quantity: string): void;
  submit(): Promise<WriteOutcome<StockMovement>>;
  /** "Retry" after a failed submission: the same movement again (same id, same lines). */
  retry(): Promise<WriteOutcome<unknown>>;
  markRecordedShown(): void;
  /** A blank form, after a success ("Record another"). */
  startOver(): void;
  reset(): void;
}

export const movementSubmission = (state: MovementFormState): WriteState => writeOf(state.writes, SUBMISSION);

export interface MovementFormConfig {
  api: Pick<MovementsApi, 'create'>;
  deps: StoreDeps;
  /** The type a blank form starts with (the user's last choice). */
  initialType(): FormMovementType;
  onTypeChange?(type: FormMovementType): void;
  onRecorded?(movement: StockMovement): void;
}

export function createMovementFormStore(config: MovementFormConfig) {
  const key = createIdempotencyKey(config.deps.newId);
  let lineCounter = 0;
  const blankLine = (): StockLine => ({ key: `line-${++lineCounter}`, product: null, quantity: '' });
  const blankForm = () => ({ type: config.initialType(), lines: [blankLine()], errors: null, recorded: null, recordedShown: false });

  return createStore<MovementFormState>()((set, get) => {
    const tracker = createWriteTracker(config.deps, { get: () => get().writes, set: (writes) => set({ writes }) });
    const pending = () => tracker.isPending(SUBMISSION);

    /** Lines cannot change while a submission is in flight: the id stands for exactly what was sent. */
    const edit = (change: () => Partial<MovementFormState>) => {
      if (pending()) return;
      set(change());
      if (movementSubmission(get()).status !== 'succeeded') tracker.dismiss(SUBMISSION);
    };
    const mapLine = (lineKey: string, change: (line: StockLine) => StockLine) =>
      get().lines.map((line) => (line.key === lineKey ? change(line) : line));
    const withoutLineError = (lineKey: string, field: 'product' | 'quantity') => {
      const errors = get().errors;
      if (errors?.lines[lineKey]?.[field] === undefined) return errors;
      const { [field]: _removed, ...rest } = errors.lines[lineKey];
      return { ...errors, lines: { ...errors.lines, [lineKey]: rest } };
    };

    return {
      ...blankForm(),
      writes: {},

      setType(type) {
        if (pending()) return;
        edit(() => ({ type, errors: null }));
        config.onTypeChange?.(type);
      },

      addLine() {
        edit(() => (get().lines.length >= MAX_ITEMS_PER_MOVEMENT ? {} : { lines: [...get().lines, blankLine()] }));
      },

      removeLine(lineKey) {
        edit(() => {
          const errors = get().errors;
          const { [lineKey]: _removed, ...lineErrors } = errors?.lines ?? {};
          return {
            lines: get().lines.filter((line) => line.key !== lineKey),
            errors: errors === null ? null : { ...errors, lines: lineErrors },
          };
        });
      },

      setProduct(lineKey, product) {
        edit(() => ({ lines: mapLine(lineKey, (line) => ({ ...line, product })), errors: withoutLineError(lineKey, 'product') }));
      },

      setQuantity(lineKey, quantity) {
        edit(() => ({ lines: mapLine(lineKey, (line) => ({ ...line, quantity })), errors: withoutLineError(lineKey, 'quantity') }));
      },

      async submit() {
        const { type, lines } = get();
        const status = movementSubmission(get()).status;
        if (status === 'pending' || status === 'succeeded') return { kind: 'cancelled' };
        const valid = validateStockForm(lines);
        if (!valid.ok) {
          set({ errors: valid.errors });
          return { kind: 'cancelled' };
        }
        const id = key.for({ type, items: valid.items });
        set({ errors: null });
        return tracker.start(SUBMISSION, {
          kind: 'create',
          input: { type, items: valid.items },
          operation: () => config.api.create(id, type, valid.items),
          onSuccess: (movement) => {
            key.clear(id);
            set({ recorded: movement });
            config.onRecorded?.(movement);
          },
          onRejected: (error) => {
            // The lines cannot change while the request is in flight, so `lines` is what was sent.
            const { errors, stock } = stockErrorsFromApi(error, lines, type);
            set({
              errors,
              // Show the stock the API reported, so the user can fix the quantities.
              lines: get().lines.map((line) =>
                line.product !== null && stock.has(line.product.id)
                  ? { ...line, product: { ...line.product, quantity: stock.get(line.product.id)! } }
                  : line,
              ),
            });
          },
        });
      },

      retry: () => tracker.retry(SUBMISSION),

      markRecordedShown() {
        set({ recordedShown: true });
      },

      startOver() {
        if (pending()) return;
        tracker.dismiss(SUBMISSION);
        set(blankForm());
      },

      reset() {
        tracker.reset();
        key.clear();
        set(blankForm());
      },
    };
  });
}
