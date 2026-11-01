// DTOs as the API returns them (backend/src/schemas is the source of truth).

export type Role = 'admin' | 'employee';

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** `price` is a canonical decimal string ("1234.50"), never a number. */
export interface Product {
  id: string;
  category: { id: string; name: string };
  brand: string;
  name: string;
  description: string;
  quantity: number;
  price: string;
  /** Optimistic locking: a PATCH sends the version it was based on. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The editable fields, as the API takes them. */
export interface ProductFields {
  categoryId: string;
  brand: string;
  name: string;
  description: string;
  quantity: number;
  price: string;
}

export type MovementType = 'sale' | 'restock' | 'adjustment';
/** The stock form records only these; adjustments come from admin edits. */
export type FormMovementType = Exclude<MovementType, 'adjustment'>;

/** The author's name and each product's name, brand and price are snapshots; ids turn null once deleted. */
export interface StockMovement {
  id: string;
  type: MovementType;
  user: { id: string | null; fullName: string };
  items: {
    product: { id: string | null; name: string; brand: string };
    unitPrice: string;
    /** Negative for a sale, positive for a restock. */
    delta: number;
    quantityAfter: number;
  }[];
  createdAt: string;
}

export interface MovementLineInput {
  productId: string;
  quantity: number;
}

export interface Stats {
  lowStockThreshold: number;
  products: { total: number; outOfStock: number; lowStock: number; totalUnits: number; inventoryValue: string };
  categories: { total: number };
  movements: Record<MovementType, number>;
  /** Only for admins. */
  employees?: { total: number };
}

export interface EmployeeFields {
  fullName: string;
  email: string;
  password: string;
}

/** One page of a keyset-paginated list; `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
