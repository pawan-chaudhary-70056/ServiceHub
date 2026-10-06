import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '../api/client';
import {
  deactivateUser,
  inviteUser,
  listAssignableRoles,
  listUsers,
  type InvitedUser,
  type TenantUser,
} from '../api/users.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';

/**
 * Tenant user administration (docs/11 §9, docs/06 §11, docs/07).
 *
 * Scoped to the caller's own organization, and guarded by `user:manage` at the route and
 * again on the server. A platform operator is refused by the API, so this screen is a
 * tenant-administrator surface (`07` §5).
 *
 * An invitation creates the identity INACTIVE and grants nothing until the invitee sets a
 * first credential (`06` §11 rule 5) — the UI reflects that by never implying the user is
 * active on invite.
 */
const inviteFormSchema = z.object({
  email: z.string().trim().min(1, 'Enter an email address.').email('Enter a valid email address.'),
  displayName: z.string().trim().max(120, 'Name is limited to 120 characters.').optional(),
  roleId: z.string().min(1, 'Select a role.'),
});

type InviteFormValues = z.infer<typeof inviteFormSchema>;

export function UsersPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [invited, setInvited] = useState<InvitedUser | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => listUsers({}, signal),
  });

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => listAssignableRoles(signal),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: '', displayName: '', roleId: '' },
  });

  const inviteMutation = useMutation({
    mutationFn: inviteUser,
    onSuccess: (data) => {
      setActionError(null);
      setInvited(data);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateUser,
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const onSubmit = handleSubmit((values) => {
    inviteMutation.mutate({
      email: values.email,
      roleId: values.roleId,
      ...(values.displayName ? { displayName: values.displayName } : {}),
    });
  });

  return (
    <div className="space-y-10">
      <section aria-labelledby="users-heading">
        <h1 id="users-heading" className="text-2xl font-semibold text-content">
          Users
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Invite people into your organization and deactivate those who have left. Open a new
          account’s deactivate control with care — deactivation is immediate and revokes their
          sessions.
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

      {/* Invite --------------------------------------------------------------- */}
      <section aria-labelledby="invite-heading" className="rounded-lg border border-border p-4">
        <h2 id="invite-heading" className="text-lg font-semibold text-content">
          Invite a user
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          The account is created inactive until the invitation is accepted and a password is set.
        </p>

        <form onSubmit={onSubmit} noValidate className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="invite-email" className="block text-sm font-medium text-content">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              autoComplete="off"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('email')}
            />
            {errors.email && <p className="text-sm text-danger">{errors.email.message}</p>}
          </div>

          <div className="space-y-1">
            <label htmlFor="invite-name" className="block text-sm font-medium text-content">
              Name <span className="text-content-muted">(optional)</span>
            </label>
            <input
              id="invite-name"
              autoComplete="off"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('displayName')}
            />
            {errors.displayName && (
              <p className="text-sm text-danger">{errors.displayName.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="invite-role" className="block text-sm font-medium text-content">
              Role
            </label>
            <select
              id="invite-role"
              disabled={roles.isPending}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...register('roleId')}
            >
              <option value="">Select a role…</option>
              {(roles.data?.items ?? []).map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            {errors.roleId && <p className="text-sm text-danger">{errors.roleId.message}</p>}
            {roles.isError && (
              <p role="alert" className="text-sm text-danger">
                {messageFor(roles.error)}
              </p>
            )}
          </div>

          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={isSubmitting || inviteMutation.isPending}
              className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
            >
              {inviteMutation.isPending ? 'Inviting…' : 'Send invitation'}
            </button>
          </div>
        </form>

        {invited && <InviteResult result={invited} />}
      </section>

      {/* User list ------------------------------------------------------------ */}
      <section aria-labelledby="user-list-heading">
        <h2 id="user-list-heading" className="text-lg font-semibold text-content">
          Organization users
        </h2>

        {users.isPending && (
          <p role="status" className="mt-3 text-sm text-content-muted">
            Loading users…
          </p>
        )}
        {users.isError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {messageFor(users.error)}
          </p>
        )}
        {users.isSuccess && users.data.items.length === 0 && (
          <p className="mt-3 text-sm text-content-muted">No users yet.</p>
        )}

        {users.isSuccess && users.data.items.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {users.data.items.map((tenantUser) => (
              <UserRow
                key={tenantUser.id}
                user={tenantUser}
                isSelf={tenantUser.id === user?.id}
                pending={deactivateMutation.isPending}
                onDeactivate={() => deactivateMutation.mutate(tenantUser.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  pending,
  onDeactivate,
}: {
  user: TenantUser;
  isSelf: boolean;
  pending: boolean;
  onDeactivate: () => void;
}) {
  const isInactive = user.status === 'INACTIVE';

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="font-medium text-content">
          {user.displayName}
          {isSelf && <span className="ml-2 text-xs text-content-muted">(you)</span>}
        </p>
        <p className="text-sm text-content-muted">{user.email}</p>
        {user.roles.length > 0 && (
          <p className="mt-1 font-mono text-xs text-content-muted">{user.roles.join(', ')}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <StatusBadge tone={isInactive ? 'neutral' : 'success'}>{user.status}</StatusBadge>
        <button
          type="button"
          disabled={pending || isSelf || isInactive}
          onClick={onDeactivate}
          title={isSelf ? 'You cannot deactivate your own account.' : undefined}
          className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-50"
        >
          Deactivate
        </button>
      </div>
    </li>
  );
}

function InviteResult({ result }: { result: InvitedUser }) {
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
        Invitation created for {result.user.email}. The account is inactive until accepted.
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
