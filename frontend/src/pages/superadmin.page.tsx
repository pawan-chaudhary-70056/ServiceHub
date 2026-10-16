import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '../api/client';
import {
  activateOrganization,
  createOrganization,
  listOperators,
  listOrganizations,
  suspendOrganization,
  type CreatedOrganization,
  type OrganizationSummary,
} from '../api/platform.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Superadmin — platform administration (`ADR-0012`, docs/04 §13, docs/07 §5).
 *
 * This is the platform operator's screen: provision a tenant, suspend or reactivate one,
 * and see the operator roster. It deliberately does **nothing else**. A platform operator
 * cannot administer a tenant's records, approve its work or read its content — that
 * separation of duties is enforced on the server, and this page is shaped to match it
 * rather than inviting actions that would be refused.
 *
 * Everything on the page is **read from the server**: the counters are the loaded pages
 * (never a guess), the roster is cursor-paginated, and every action refetches what it
 * changed. There is no client-side summary of tenant data here, because the operator has
 * no access to tenant data by design — a dashboard that showed tenant counts would be
 * either a lie or a leak.
 *
 * Permission: `platform:organization:manage` (the route enforces it; the server enforces
 * it again).
 */

const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Name must be at least 2 characters.')
    .max(120, 'Name must be at most 120 characters.'),
  administratorName: z
    .string()
    .trim()
    .min(1, 'Enter the administrator’s name.')
    .max(120, 'Name must be at most 120 characters.'),
  administratorEmail: z
    .string()
    .trim()
    .min(1, 'Enter the administrator’s email.')
    .email('Enter a valid email address.'),
});

type CreateOrganizationValues = z.infer<typeof createOrganizationSchema>;

const ORG_STATUS_TONE = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
} as const;

export function SuperAdminPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<CreatedOrganization | null>(null);

  const organizations = useInfiniteQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: ({ pageParam, signal }) =>
      listOrganizations({ ...(pageParam ? { cursor: pageParam } : {}), limit: 20 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const operators = useQuery({
    queryKey: ['platform', 'operators'],
    queryFn: ({ signal }) => listOperators(signal),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationValues>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: '', administratorName: '', administratorEmail: '' },
  });

  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: (data) => {
      setActionError(null);
      setProvisioned(data);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['platform', 'organizations'] });
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; suspend: boolean }) =>
      input.suspend ? suspendOrganization(input.id) : activateOrganization(input.id),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'organizations'] });
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const onSubmit = handleSubmit((values) => {
    createMutation.mutate(values);
  });

  // The counters are the rows the server has actually returned for this caller — the pages
  // loaded so far — rather than a number computed somewhere the caller cannot audit.
  const organizationsLoaded = organizations.data?.pages.flatMap((page) => page.items) ?? [];
  const activeCount = organizationsLoaded.filter((org) => org.status === 'ACTIVE').length;
  const suspendedCount = organizationsLoaded.filter((org) => org.status === 'SUSPENDED').length;

  return (
    <div className="space-y-10">
      <section aria-labelledby="superadmin-heading">
        <h1 id="superadmin-heading" className="text-2xl font-semibold text-content">
          Platform administration
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Provision organizations and manage platform access. Platform administration is separate
          from tenant administration by design.
        </p>
      </section>

      {actionError && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {actionError}
        </p>
      )}

      {/* Live counters ------------------------------------------------------- */}
      <section aria-labelledby="platform-stats-heading">
        <h2 id="platform-stats-heading" className="sr-only">
          Platform at a glance
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Counter
            label="Organizations loaded"
            value={organizations.isPending ? '…' : String(organizationsLoaded.length)}
            hint={organizations.data?.pages.at(-1)?.hasMore ? 'more available below' : 'all loaded'}
          />
          <Counter
            label="Active"
            value={organizations.isPending ? '…' : String(activeCount)}
            hint="accepting sign-in"
          />
          <Counter
            label="Suspended"
            value={organizations.isPending ? '…' : String(suspendedCount)}
            hint="sign-in refused"
          />
          <Counter
            label="Operators"
            value={operators.isPending ? '…' : String(operators.data?.items.length ?? 0)}
            hint="belong to no tenant"
          />
        </dl>
      </section>

      {/* Provision a tenant -------------------------------------------------- */}
      <section aria-labelledby="provision-heading" className="rounded-lg border border-border p-4">
        <h2 id="provision-heading" className="text-lg font-semibold text-content">
          Provision an organization
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          Creates the tenant, seeds its roles and invites its first administrator. No password is
          set here — the administrator chooses one from the invitation.
        </p>

        <form onSubmit={onSubmit} noValidate className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="org-name" className="block text-sm font-medium text-content">
              Organization name
            </label>
            <input
              id="org-name"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('name')}
            />
            {errors.name && <p className="text-sm text-danger">{errors.name.message}</p>}
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-name" className="block text-sm font-medium text-content">
              Administrator name
            </label>
            <input
              id="admin-name"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('administratorName')}
            />
            {errors.administratorName && (
              <p className="text-sm text-danger">{errors.administratorName.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-email" className="block text-sm font-medium text-content">
              Administrator email
            </label>
            <input
              id="admin-email"
              type="email"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('administratorEmail')}
            />
            {errors.administratorEmail && (
              <p className="text-sm text-danger">{errors.administratorEmail.message}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <button
              type="submit"
              disabled={isSubmitting || createMutation.isPending}
              className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
            >
              {createMutation.isPending ? 'Provisioning…' : 'Provision organization'}
            </button>
            <button
              type="button"
              disabled={organizations.isRefetching}
              onClick={() => void organizations.refetch()}
              className="rounded border border-border px-4 py-2 text-sm text-content disabled:opacity-60"
            >
              {organizations.isRefetching ? 'Refreshing…' : 'Refresh list'}
            </button>
          </div>
        </form>

        {provisioned && <ProvisionResult result={provisioned} />}
      </section>

      {/* Tenant list --------------------------------------------------------- */}
      <section aria-labelledby="organizations-heading">
        <h2 id="organizations-heading" className="text-lg font-semibold text-content">
          Organizations
        </h2>

        {organizations.isPending && (
          <p role="status" className="mt-3 text-sm text-content-muted">
            Loading organizations…
          </p>
        )}
        {organizations.isError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {messageFor(organizations.error)}
          </p>
        )}
        {organizations.isSuccess && organizationsLoaded.length === 0 && (
          <p className="mt-3 text-sm text-content-muted">No organizations yet.</p>
        )}

        {organizationsLoaded.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-muted text-xs uppercase tracking-wide text-content-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Organization
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Slug
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Time zone
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {organizationsLoaded.map((organization) => (
                  <OrganizationRow
                    key={organization.id}
                    organization={organization}
                    pending={statusMutation.isPending}
                    onToggle={(suspend) => statusMutation.mutate({ id: organization.id, suspend })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {organizations.hasNextPage && (
          <button
            type="button"
            disabled={organizations.isFetchingNextPage}
            onClick={() => void organizations.fetchNextPage()}
            className="mt-3 rounded border border-border px-4 py-2 text-sm text-content disabled:opacity-60"
          >
            {organizations.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>

      {/* Operator roster ----------------------------------------------------- */}
      <section aria-labelledby="operators-heading">
        <h2 id="operators-heading" className="text-lg font-semibold text-content">
          Platform operators
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          Platform operators belong to no organization and cannot administer tenant work.
        </p>

        {operators.isPending && (
          <p role="status" className="mt-3 text-sm text-content-muted">
            Loading operators…
          </p>
        )}
        {operators.isError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {messageFor(operators.error)}
          </p>
        )}
        {operators.isSuccess && operators.data.items.length === 0 && (
          <p className="mt-3 text-sm text-content-muted">No platform operators.</p>
        )}
        {operators.isSuccess && operators.data.items.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {operators.data.items.map((operator) => (
              <li key={operator.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="font-medium text-content">{operator.displayName}</p>
                  <p className="text-sm text-content-muted">{operator.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-content-muted">
                    {formatDate(operator.createdAt)}
                  </span>
                  <StatusBadge tone={operator.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {operator.status}
                  </StatusBadge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Counter({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
      <dt className="text-sm text-content-muted">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold text-content">{value}</dd>
      {hint && <p className="mt-1 text-xs text-content-muted">{hint}</p>}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function OrganizationRow({
  organization,
  pending,
  onToggle,
}: {
  organization: OrganizationSummary;
  pending: boolean;
  onToggle: (suspend: boolean) => void;
}) {
  const isSuspended = organization.status === 'SUSPENDED';

  return (
    <tr>
      <td className="px-4 py-3">
        <p className="font-medium text-content">{organization.name}</p>
        <p className="font-mono text-xs text-content-muted">{organization.id}</p>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-content-muted">{organization.slug}</td>
      <td className="px-4 py-3 text-content-muted">{organization.defaultTimeZone}</td>
      <td className="px-4 py-3 text-content-muted">{formatDate(organization.createdAt)}</td>
      <td className="px-4 py-3">
        <StatusBadge tone={ORG_STATUS_TONE[organization.status]}>{organization.status}</StatusBadge>
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={pending}
          onClick={() => onToggle(!isSuspended)}
          className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-60"
        >
          {isSuspended ? 'Reactivate' : 'Suspend'}
        </button>
      </td>
    </tr>
  );
}

function ProvisionResult({ result }: { result: CreatedOrganization }) {
  const token = result.invitation.token;
  const inviteUrl =
    token && typeof window !== 'undefined'
      ? `${window.location.origin}/accept-invitation?token=${encodeURIComponent(token)}`
      : null;

  return (
    <div
      role="status"
      className="mt-4 rounded border border-success/30 bg-success/10 px-3 py-3 text-sm"
    >
      <p className="font-medium text-content">
        {result.organization.name} is provisioned. The administrator is invited and inactive until
        they accept.
      </p>

      {inviteUrl ? (
        <p className="mt-2 break-all text-content-muted">
          Invitation link (shown outside production only):{' '}
          <a href={inviteUrl} className="text-brand underline">
            {inviteUrl}
          </a>
        </p>
      ) : (
        <p className="mt-2 text-content-muted">
          The invitation email has been queued. The link travels only in that email.
        </p>
      )}
    </div>
  );
}

/** Maps an unknown error to a safe, user-facing message. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
