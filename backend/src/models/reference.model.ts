import { randomUUID } from 'node:crypto';
import { prisma, type DataClient } from './db';

/**
 * Human-readable reference allocation (docs/22 §4).
 *
 * `REQ-YYYY-NNNNNN` must be unique under concurrency, and the allocation must not abort
 * the caller's transaction. The first naive approach — `create`, catch the unique
 * violation, then `update` — is wrong in PostgreSQL: a statement that errors **aborts the
 * whole transaction**, so the follow-up `update` fails with `25P02` and the request is
 * lost.
 *
 * The fix is a single atomic statement: `INSERT … ON CONFLICT DO UPDATE … RETURNING`,
 * which either inserts the first value or increments the existing one, in one round trip,
 * without ever raising an error. The counter is per `(organization, type, period)`, so
 * each tenant and each year gets its own sequence.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export type ReferenceType = 'REQ' | 'INC';

export async function reserveReferenceValue(
  organizationId: string,
  type: ReferenceType,
  period: string,
  client: DataClient = prisma,
): Promise<number> {
  const rows = await client.$queryRaw<Array<{ value: number }>>`
    INSERT INTO reference_sequences (id, organization_id, type, period, value, updated_at)
    VALUES (${randomUUID()}, ${organizationId}, ${type}, ${period}, 1, now())
    ON CONFLICT (organization_id, type, period)
    DO UPDATE SET value = reference_sequences.value + 1, updated_at = now()
    RETURNING value
  `;

  const value = rows[0]?.value;
  if (typeof value !== 'number') {
    // Cannot happen with the statement above; failing loudly beats a request numbered
    // `undefined`.
    throw new Error('Reference allocation returned no value.');
  }
  return value;
}
