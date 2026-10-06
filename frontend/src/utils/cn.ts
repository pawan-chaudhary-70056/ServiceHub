/**
 * Joins conditional class names.
 *
 * Conditional classes are how a component expresses state (`tone`, `disabled`,
 * `selected`). Returning `null` or `false` from a condition is the readable form, and
 * this helper keeps that from producing the literal string "false" in `className`.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(' ');
}
