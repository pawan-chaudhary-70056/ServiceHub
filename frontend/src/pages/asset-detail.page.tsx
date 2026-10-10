import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  assignAsset,
  disposeAsset,
  getAsset,
  retireAsset,
  returnAsset,
  type AssetHolderType,
  type AssetState,
} from '../api/assets.api';
import { listTeams } from '../api/teams.api';
import { listUsers } from '../api/users.api';
import { RecordHistoryPanel } from '../components/record-history-panel';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Asset detail (docs/28 §9).
 *
 * Two rules are visible in the UI because they are visible in the API:
 *
 *   - **Linking is not ownership transfer** (§7). Nothing on this screen changes a holder
 *     implicitly; `assign` and `return` are explicit, permissioned and audited.
 *   - **AM6** — the holder is read from the server's `holder`, never inferred from
 *     `state`. A cached `state` that disagrees with the assignment history is exactly the
 *     defect the register exists to prevent.
 */

const STATE_TONE: Record<AssetState, Tone> = {
  PROCURED: 'info',
  IN_STOCK: 'neutral',
  ASSIGNED: 'success',
  IN_REPAIR: 'warning',
  RETIRED: 'neutral',
  DISPOSED: 'neutral',
};

export function AssetDetailPage() {
  const { id = '' } = useParams();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const canAssign = hasPermission('asset:assign');
  const canManage = hasPermission('asset:manage');

  const asset = useQuery({
    queryKey: ['asset', id],
    queryFn: ({ signal }) => getAsset(id, signal),
    enabled: id !== '',
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['asset', id] });
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
  }

  const action = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  if (asset.isPending) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Loading asset…
      </p>
    );
  }
  if (asset.isError) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-danger">
          {messageFor(asset.error)}
        </p>
        <Link to="/assets" className="text-sm text-brand underline">
          Back to the register
        </Link>
      </div>
    );
  }

  const value = asset.data.asset;
  const isOpenState = value.state !== 'RETIRED' && value.state !== 'DISPOSED';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/assets" className="text-xs text-content-muted underline">
            Assets
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-content">{value.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral">
              <span className="font-mono">{value.tag}</span>
            </StatusBadge>
            <StatusBadge tone={STATE_TONE[value.state]}>{value.state}</StatusBadge>
            <StatusBadge tone="neutral">{value.assetType.name}</StatusBadge>
            {value.warrantyExpired && <StatusBadge tone="warning">Warranty expired</StatusBadge>}
          </div>
        </div>
        {canManage && isOpenState && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const reason = window.prompt('Why is this asset being retired?') ?? '';
                action.mutate(() => retireAsset(id, reason || undefined));
              }}
              className="rounded border border-border px-3 py-2 text-sm text-content"
            >
              Retire
            </button>
          </div>
        )}
        {canManage && value.state === 'RETIRED' && (
          <button
            type="button"
            onClick={() => {
              const reason = window.prompt('Why is this asset being disposed?') ?? '';
              action.mutate(() => disposeAsset(id, reason || undefined));
            }}
            className="rounded border border-border px-3 py-2 text-sm text-content"
          >
            Dispose
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-content-muted">Holder</dt>
          <dd className="text-content">
            {value.holder.user
              ? value.holder.user.displayName
              : value.holder.team
                ? `${value.holder.team.name} (team)`
                : 'Nobody holds this asset'}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-content-muted">Serial number</dt>
          <dd className="font-mono text-content">{value.serialNumber ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-content-muted">Warranty expires</dt>
          <dd className="text-content">
            {value.warrantyExpiresAt ? new Date(value.warrantyExpiresAt).toLocaleDateString() : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-content-muted">Attributes</dt>
          <dd className="text-content">
            {Object.keys(value.attributes).length === 0
              ? '—'
              : Object.entries(value.attributes)
                  .map(([key, attribute]) => `${key}: ${String(attribute)}`)
                  .join(', ')}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="asset-assign" className="space-y-2">
        <h2 id="asset-assign" className="text-sm font-semibold text-content">
          Assignment
        </h2>
        {canAssign && !value.openAssignment && isOpenState && (
          <AssignForm assetId={id} onAssigned={refresh} onError={setError} />
        )}
        {canAssign && value.openAssignment && (
          <button
            type="button"
            onClick={() => action.mutate(() => returnAsset(id))}
            className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted"
          >
            Return asset
          </button>
        )}
        {!canAssign && (
          <p className="text-sm text-content-muted">
            You can see this asset; assigning it needs `asset:assign`.
          </p>
        )}
      </section>

      <section aria-labelledby="asset-history" className="space-y-2">
        <h2 id="asset-history" className="text-sm font-semibold text-content">
          Assignment history
        </h2>
        {value.assignments.length === 0 ? (
          <p className="text-sm text-content-muted">This asset has never been assigned.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Assignment intervals, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-content-muted">
                <th scope="col" className="py-2 pr-4">
                  Holder
                </th>
                <th scope="col" className="py-2 pr-4">
                  From
                </th>
                <th scope="col" className="py-2 pr-4">
                  To
                </th>
                <th scope="col" className="py-2">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody>
              {value.assignments.map((assignment) => (
                <tr key={assignment.id} className="border-b border-border">
                  <td className="py-2 pr-4 text-content">
                    {assignment.holderType === 'USER'
                      ? holderName(assignment.userId, value.holder.user?.id ?? null, value)
                      : 'Team'}
                    {assignment.returnedAt === null && (
                      <span className="ml-2">
                        <StatusBadge tone="success">Open</StatusBadge>
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-content-muted">
                    {new Date(assignment.assignedAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 text-content-muted">
                    {assignment.returnedAt ? new Date(assignment.returnedAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 text-content-muted">{assignment.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-content-muted">
          Intervals are history: returning an asset closes the interval, it never deletes it.
        </p>
      </section>

      {/* Record history (docs/31 §11): the asset's own audit trail, authorised by holder
          visibility (`asset:read.own`) or the wider `asset:read.any`. */}
      <RecordHistoryPanel entityType="Asset" entityId={value.id} />
    </div>
  );
}

/** The open holder's display name, when the history row *is* the current holder. */
function holderName(
  userId: string | null,
  currentHolderId: string | null,
  asset: { holder: { user: { id: string; displayName: string } | null } },
): string {
  if (userId && userId === currentHolderId && asset.holder.user)
    return asset.holder.user.displayName;
  return userId ?? 'Unknown holder';
}

function AssignForm({
  assetId,
  onAssigned,
  onError,
}: {
  assetId: string;
  onAssigned: () => void;
  onError: (message: string) => void;
}) {
  const { hasPermission } = useAuth();
  const [holderType, setHolderType] = useState<AssetHolderType>('USER');
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [notes, setNotes] = useState('');

  // Teams are readable by any tenant member (`catalog:read`); the user directory is not,
  // so the user picker degrades to a free-text id for a caller without `user:manage`.
  const canListUsers = hasPermission('user:manage');
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => listTeams(signal),
    enabled: holderType === 'TEAM',
  });
  const users = useQuery({
    queryKey: ['users', 'picker'],
    queryFn: ({ signal }) => listUsers({ limit: 100 }, signal),
    enabled: holderType === 'USER' && canListUsers,
  });

  const assign = useMutation({
    mutationFn: () =>
      assignAsset(assetId, {
        holderType,
        userId: holderType === 'USER' ? userId : null,
        teamId: holderType === 'TEAM' ? teamId : null,
        notes: notes || null,
      }),
    onSuccess: onAssigned,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        assign.mutate();
      }}
    >
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="holderType"
            checked={holderType === 'USER'}
            onChange={() => setHolderType('USER')}
          />
          <span className="text-content">A person</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="holderType"
            checked={holderType === 'TEAM'}
            onChange={() => setHolderType('TEAM')}
          />
          <span className="text-content">A team</span>
        </label>
      </div>

      {holderType === 'USER' ? (
        canListUsers ? (
          <label className="block text-sm">
            <span className="text-content-muted">Holder</span>
            <select
              required
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="mt-1 block w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
            >
              <option value="">Select a person</option>
              {(users.data?.items ?? [])
                .filter((user) => user.status === 'ACTIVE')
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <label className="block text-sm">
            <span className="text-content-muted">Holder user id</span>
            <input
              required
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="User identifier"
              className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
            />
          </label>
        )
      ) : (
        <label className="block text-sm">
          <span className="text-content-muted">Holder team</span>
          <select
            required
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
            className="mt-1 block w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">Select a team</option>
            {(teams.data?.items ?? [])
              .filter((team) => team.isActive)
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
          </select>
        </label>
      )}

      <label className="block text-sm">
        <span className="text-content-muted">Notes</span>
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>

      <button
        type="submit"
        disabled={assign.isPending}
        className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-60"
      >
        {assign.isPending ? 'Assigning…' : 'Assign'}
      </button>
    </form>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
