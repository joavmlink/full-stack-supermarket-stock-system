// Limits the API enforces (backend/src/db/schema.ts and schemas), mirrored so
// forms can explain them before sending. The API stays the authority.

/** The most units a product can hold. */
export const MAX_QUANTITY = 1_000_000;
/** The most lines one stock form can have. */
export const MAX_ITEMS_PER_MOVEMENT = 50;
/** The most units one line of the stock form can move. */
export const MAX_LINE_QUANTITY = 100_000;
/** 1 to this many units is "low stock" (GET /stats also returns it as lowStockThreshold). */
export const LOW_STOCK_THRESHOLD = 10;
/** Text lengths, after trim + NFC (the API's `textSchema`). */
export const CATEGORY_NAME_MAX = 60;
export const PRODUCT_BRAND_MAX = 60;
export const PRODUCT_NAME_MAX = 100;
export const PRODUCT_DESCRIPTION_MAX = 1000;
export const FULL_NAME_MAX = 100;
export const EMAIL_MAX = 254;
/** The products search (`q`). */
export const SEARCH_MAX = 100;
/** NIST SP 800-63B-4 lengths, in code points. */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
/** The largest page the API serves. */
export const MAX_PAGE_SIZE = 100;
