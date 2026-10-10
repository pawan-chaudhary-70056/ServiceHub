import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '../api/client';
import {
  addTeamMember,
  createTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  type TeamSummary,
} from '../api/teams.api';
import { listUsers, type TenantUser } from '../api/users.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Team administration (docs/07 §6, docs/11 §9, docs/16).
 *
 * Teams are the ownership and routing unit: a catalog item's fulfilment team becomes a
 * request's default owning team, and membership is what makes `request:read.team` resolve
 * to a real set of records. That is why this screen takes `user:manage` — changing
 * membership widens who can see and update records, so it is user administration rather
 * than catalog browsing (`07` §6).
 *
 * The screen is a convenience, never a control: the route guard and the server both
 * re-check the permission, and the server scopes every call to the caller's tenant. A team
 * from another tenant is a 404 here, exactly as the API reports it, so nothing distinguishes
 * "not yours" from "does not exist" (`docs/17` §5).
 */

const createTeamSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name of at least 2 characters.').max(80),
  description: z.string().trim().max(500).optional(),
});

type CreateTeamValues = z.infer<typeof createTeamSchema>;

const addMemberSchema = z.object({
  userId: z.string().min(1, 'Select a person.'),
  role: z.enum(['MEMBER', 'LEAD']),
});

type AddMemberValues = z.infer<typeof addMemberSchema>;

export function TeamsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => listTeams(signal),
  });

  const users = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => listUsers({ limit: 100 }, signal),
  });

  const detail = useQuery({
    queryKey: ['team', selectedId],
    queryFn: ({ signal }) => getTeam(selectedId as string, signal),
    enabled: selectedId !== null,
  });

  const createForm = useForm<CreateTeamValues>({
    resolver: zodResolver(createTeamSchema),
    defaultValues: { name: '', description: '' },
  });

  const memberForm = useForm<AddMemberValues>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { userId: '', role: 'MEMBER' },
  });

  const invalidate = (teamId: string | null): void => {
    void queryClient.invalidateQueries({ queryKey: ['teams'] });
    if (teamId) {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] });
    }
  };

  const createMutation = useMutation({
    mutationFn: createTeam,
    onSuccess: ({ team }) => {
      setActionError(null);
      setSelectedId(team.id);
      createForm.reset();
      invalidate(team.id);
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const addMutation = useMutation({
    mutationFn: (values: AddMemberValues) => addTeamMember(selectedId as string, values),
    onSuccess: () => {
      setActionError(null);
      memberForm.reset({ userId: '', role: 'MEMBER' });
      invalidate(selectedId);
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeTeamMember(selectedId as string, userId),
    onSuccess: () => {
      setActionError(null);
      invalidate(selectedId);
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  const onCreate = createForm.handleSubmit((values) => {
    createMutation.mutate({
      name: values.name,
      ...(values.description ? { description: values.description } : {}),
    });
  });

  const onAddMember = memberForm.handleSubmit((values) => addMutation.mutate(values));

  return (
    <div className="space-y-10">
      <section aria-labelledby="teams-heading">
        <h1 id="teams-heading" className="text-2xl font-semibold text-content">
          Teams
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Teams own and route work: a catalog item routes to a team, and team membership is what
          grants a member visibility of that team’s records. Add people deliberately — a membership
          change takes effect on their next request, not at the next sign-in.
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

      {/* Create ------------------------------------------------------------ */}
      <section
        aria-labelledby="create-team-heading"
        className="rounded-lg border border-border p-4"
      >
        <h2 id="create-team-heading" className="text-lg font-semibold text-content">
          Create a team
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          Names are unique per organization: two teams with the same name would make every routing
          picker ambiguous.
        </p>

        <form onSubmit={onCreate} noValidate className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="team-name" className="block text-sm font-medium text-content">
              Name
            </label>
            <input
              id="team-name"
              autoComplete="off"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...createForm.register('name')}
            />
            {createForm.formState.errors.name && (
              <p className="text-sm text-danger">{createForm.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="team-description" className="block text-sm font-medium text-content">
              Description <span className="text-content-muted">(optional)</span>
            </label>
            <input
              id="team-description"
              autoComplete="off"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              {...createForm.register('description')}
            />
          </div>

          <div className="flex items-end sm:col-span-1">
            <button
              type="submit"
              disabled={createForm.formState.isSubmitting || createMutation.isPending}
              className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
            >
              {createMutation.isPending ? 'Creating…' : 'Create team'}
            </button>
          </div>
        </form>
      </section>

      {/* List ------------------------------------------------------------- */}
      <section aria-labelledby="team-list-heading">
        <h2 id="team-list-heading" className="text-lg font-semibold text-content">
          Organization teams
        </h2>

        {teams.isPending && (
          <p role="status" className="mt-3 text-sm text-content-muted">
            Loading teams…
          </p>
        )}
        {teams.isError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {messageFor(teams.error)}
          </p>
        )}
        {teams.isSuccess && teams.data.items.length === 0 && (
          <p className="mt-3 text-sm text-content-muted">
            No teams yet. Create one to start routing work.
          </p>
        )}

        {teams.isSuccess && teams.data.items.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {teams.data.items.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                isSelected={team.id === selectedId}
                onSelect={() => setSelectedId(team.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Membership ------------------------------------------------------- */}
      {selectedId && (
        <section aria-labelledby="members-heading" className="rounded-lg border border-border p-4">
          <h2 id="members-heading" className="text-lg font-semibold text-content">
            Membership
          </h2>

          {detail.isPending && (
            <p role="status" className="mt-3 text-sm text-content-muted">
              Loading members…
            </p>
          )}
          {detail.isError && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {messageFor(detail.error)}
            </p>
          )}

          {detail.isSuccess && (
            <>
              <p className="mt-1 text-sm text-content-muted">
                {detail.data.team.name}
                {detail.data.team.description ? ` — ${detail.data.team.description}` : ''}
              </p>

              {detail.data.team.members.length === 0 ? (
                <p className="mt-3 text-sm text-content-muted">
                  No members yet. A team with no members owns work nobody can see.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                  {detail.data.team.members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex flex-wrap items-center justify-between gap-4 px-4 py-3"
                    >
                      <div>
                        <p className="font-medium text-content">{member.displayName}</p>
                        <p className="text-sm text-content-muted">{member.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge tone={member.role === 'LEAD' ? 'success' : 'neutral'}>
                          {member.role}
                        </StatusBadge>
                        <button
                          type="button"
                          aria-label={`Remove ${member.displayName}`}
                          disabled={removeMutation.isPending}
                          onClick={() => removeMutation.mutate(member.userId)}
                          className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form
                onSubmit={onAddMember}
                noValidate
                className="mt-4 grid gap-4 sm:grid-cols-3"
                aria-label="Add a team member"
              >
                <div className="space-y-1">
                  <label htmlFor="member-user" className="block text-sm font-medium text-content">
                    Person
                  </label>
                  <select
                    id="member-user"
                    disabled={users.isPending}
                    className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
                    {...memberForm.register('userId')}
                  >
                    <option value="">Select a person…</option>
                    {activeUsers(users.data?.items ?? []).map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} — {user.email}
                        {detail.data.team.members.some((m) => m.userId === user.id)
                          ? ' (already a member)'
                          : ''}
                      </option>
                    ))}
                  </select>
                  {memberForm.formState.errors.userId && (
                    <p className="text-sm text-danger">
                      {memberForm.formState.errors.userId.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label htmlFor="member-role" className="block text-sm font-medium text-content">
                    Role
                  </label>
                  <select
                    id="member-role"
                    className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
                    {...memberForm.register('role')}
                  >
                    <option value="MEMBER">MEMBER</option>
                    <option value="LEAD">LEAD</option>
                  </select>
                  <p className="text-xs text-content-muted">
                    Selecting someone already on the team changes their role.
                  </p>
                </div>

                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={memberForm.formState.isSubmitting || addMutation.isPending}
                    className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
                  >
                    {addMutation.isPending ? 'Adding…' : 'Add member'}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function TeamRow({
  team,
  isSelected,
  onSelect,
}: {
  team: TeamSummary;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="font-medium text-content">{team.name}</p>
        {team.description && <p className="text-sm text-content-muted">{team.description}</p>}
      </div>
      <div className="flex items-center gap-3">
        {!team.isActive && <StatusBadge tone="neutral">INACTIVE</StatusBadge>}
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={onSelect}
          className="rounded border border-border px-3 py-1 text-sm text-content"
        >
          {isSelected ? 'Selected' : 'Manage members'}
        </button>
      </div>
    </li>
  );
}

/**
 * The people a member can be picked from: active users of the tenant only. The server
 * refuses an inactive or foreign user (`07` §6), so a picker that offers one would be a
 * trap rather than a convenience.
 */
function activeUsers(users: TenantUser[]): TenantUser[] {
  return users.filter((user) => user.status === 'ACTIVE');
}

/** Kept in one place so a 403/404 from the API reads the same everywhere on this screen. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
