import { Link } from 'react-router-dom';

/**
 * Not-found page.
 *
 * The copy is written for a service-desk user, not for a developer: it says what
 * happened and offers the one action that helps. It does not echo the attempted path
 * back into the page, because a URL can carry a record identifier and rendering it
 * again is an unnecessary disclosure (docs/17, docs/16 §10).
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
      <h1 className="text-2xl font-semibold text-content">Not found</h1>
      <p className="text-content-muted">
        We could not find that page. The link may be out of date, or the item may no longer be
        available to you.
      </p>
      <p>
        <Link to="/" className="text-brand underline">
          Return to the home page
        </Link>
      </p>
    </div>
  );
}
