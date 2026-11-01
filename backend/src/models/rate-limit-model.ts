import type pg from 'pg';
import { z } from 'zod';

const HitRow = z.object({ hits: z.number().int(), reset_at: z.date() });

/** Atomically counts a hit, starting a new window when the current one expired. */
export async function incrementHit(pool: pg.Pool, key: string, windowMs: number) {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits AS r (key, hits, reset_at)
     VALUES ($1, 1, now() + $2 * interval '1 millisecond')
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
       reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
     RETURNING hits, reset_at`,
    [key, windowMs],
  );
  const row = HitRow.parse(rows[0]);
  return { hits: row.hits, resetAt: row.reset_at };
}

export async function decrementHit(pool: pg.Pool, key: string): Promise<void> {
  await pool.query(
    'UPDATE rate_limits SET hits = greatest(hits - 1, 0) WHERE key = $1 AND reset_at > now()',
    [key],
  );
}

export async function resetHits(pool: pg.Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM rate_limits WHERE key = $1', [key]);
}

export async function deleteExpiredHits(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM rate_limits WHERE reset_at <= now()');
}
