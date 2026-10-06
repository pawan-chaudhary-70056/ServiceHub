/**
 * Request metadata passed into services.
 *
 * Services must not know about `req`/`res` (docs/03 §4), but they DO need the values
 * that make an audit record findable: the correlation id that ties a mutation to the
 * request, and the source address/agent that identify who caused it (docs/31). Passing
 * a small, transport-agnostic struct is how that need is met without importing Express.
 */
export interface RequestMeta {
  correlationId: string;
  sourceIp?: string | null;
  userAgent?: string | null;
}
