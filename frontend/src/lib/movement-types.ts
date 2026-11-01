import type { FormMovementType, MovementType } from '../api/types';

/** Every movement type, in the order the UI lists them. */
export const MOVEMENT_TYPES: readonly MovementType[] = ['sale', 'restock', 'adjustment'];
/** The types the stock form records (adjustments come from admin edits). */
export const FORM_MOVEMENT_TYPES: readonly FormMovementType[] = ['sale', 'restock'];

export const MOVEMENT_TYPE_LABELS: Record<MovementType, { one: string; many: string }> = {
  sale: { one: 'Sale', many: 'Sales' },
  restock: { one: 'Restock', many: 'Restocks' },
  adjustment: { one: 'Adjustment', many: 'Adjustments' },
};

export const isMovementType = (value: unknown): value is MovementType => MOVEMENT_TYPES.includes(value as MovementType);
export const isFormMovementType = (value: unknown): value is FormMovementType =>
  FORM_MOVEMENT_TYPES.includes(value as FormMovementType);
