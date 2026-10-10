import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createAsset,
  listAssets,
  listAssetTypes,
  type AssetState,
  type AssetListItem,
} from '../api/assets.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Asset register (docs/28 §9).
 *
 * The list is scoped **server-side** to the caller's read scope (a holder sees what they
 * hold; `asset:read.any` sees the tenant) — this screen never applies a scope of its own.
 * The register knows the assets and who holds them; lifecycle actions live on the detail.
 */

const STATES: AssetState[] = [
  'PROCURED',
  'IN_STOCK',
  'ASSIGNED',
  'IN_REPAIR',
  'RETIRED',
  'DISPOSED',
];

const STATE_TONE: Record<AssetState, Tone> = {
  PROCURED: 'info',
  IN_STOCK: 'neutral',
  ASSIGNED: 'success',
  IN_REPAIR: 'warning',
  RETIRED: 'neutral',
  DISPOSED: 'neutral',
};

function holderLabel(asset: AssetListItem): string {
  if (asset.holder.user) return asset.holder.user.displayName;
  if (asset.holder.team) return `${asset.holder.team.name} (team)`;
  return '—';
}

export function AssetsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('asset:manage');

  const [state, setState] = useState<AssetState | ''>('');
  const [assetTypeId, setAssetTypeId] = useState('');
  const [showForm, setShowForm] = useState(false);

  const assets = useQuery({
    queryKey: ['assets', { state, assetTypeId }],
    queryFn: ({ signal }) =>
      listAssets(
        {
          ...(state ? { state } : {}),
          ...(assetTypeId ? { assetTypeId } : {}),
        },
        signal,
      ),
  });

  const types = useQuery({
    queryKey: ['asset-types'],
    queryFn: ({ signal }) => listAssetTypes(signal),
  });

  const activeTypes = (types.data?.items ?? []).filter((type) => type.isActive);

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="assets-heading"
        className="flex flex-wrap items-start justify-between gap-3"
      >
        <div>
          <h1 id="assets-heading" className="text-2xl font-semibold text-content">
            Assets
          </h1>
          <p className="mt-2 max-w-3xl text-content-muted">
            The register answers what we have, who holds it, and (through the assignment history)
            who held it when it failed.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted"
          >
            {showForm ? 'Close form' : 'Register asset'}
          </button>
        )}
      </section>

      {showForm && canManage && (
        <NewAssetForm assetTypes={activeTypes} onCreated={() => setShowForm(false)} />
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">State</span>
          <select
            value={state}
            onChange={(event) => setState(event.target.value as AssetState | '')}
            className="rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">All</option>
            {STATES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Type</span>
          <select
            value={assetTypeId}
            onChange={(event) => setAssetTypeId(event.target.value)}
            className="rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">All</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {assets.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading assets…
        </p>
      )}
      {assets.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(assets.error)}
        </p>
      )}
      {assets.isSuccess && assets.data.items.length === 0 && (
        <p className="text-sm text-content-muted">No assets match this filter.</p>
      )}

      {assets.isSuccess && assets.data.items.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Assets in the register</caption>
          <thead>
            <tr className="border-b border-border text-left text-content-muted">
              <th scope="col" className="py-2 pr-4">
                Tag
              </th>
              <th scope="col" className="py-2 pr-4">
                Name
              </th>
              <th scope="col" className="py-2 pr-4">
                Type
              </th>
              <th scope="col" className="py-2 pr-4">
                Holder
              </th>
              <th scope="col" className="py-2 pr-4">
                State
              </th>
              <th scope="col" className="py-2">
                Warranty
              </th>
            </tr>
          </thead>
          <tbody>
            {assets.data.items.map((asset) => (
              <tr key={asset.id} className="border-b border-border">
                <td className="py-2 pr-4 font-mono text-xs">
                  <Link to={`/assets/${asset.id}`} className="text-brand underline">
                    {asset.tag}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-content">{asset.name}</td>
                <td className="py-2 pr-4 text-content-muted">{asset.assetType.name}</td>
                <td className="py-2 pr-4 text-content">{holderLabel(asset)}</td>
                <td className="py-2 pr-4">
                  <StatusBadge tone={STATE_TONE[asset.state]}>{asset.state}</StatusBadge>
                </td>
                <td className="py-2 text-content-muted">
                  {asset.warrantyExpiresAt
                    ? new Date(asset.warrantyExpiresAt).toLocaleDateString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewAssetForm({
  assetTypes,
  onCreated,
}: {
  assetTypes: Array<{ id: string; name: string }>;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [assetTypeId, setAssetTypeId] = useState(assetTypes[0]?.id ?? '');
  const [name, setName] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [attributes, setAttributes] = useState('{}');
  const [warrantyExpiresAt, setWarrantyExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createAsset({
        assetTypeId,
        name,
        serialNumber: serialNumber || null,
        state: 'IN_STOCK',
        attributes: parseAttributes(attributes),
        warrantyExpiresAt: warrantyExpiresAt || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      onCreated();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        create.mutate();
      }}
    >
      <h2 className="text-lg font-semibold text-content">Register an asset</h2>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <label className="block text-sm">
        <span className="text-content-muted">Type</span>
        <select
          required
          value={assetTypeId}
          onChange={(event) => setAssetTypeId(event.target.value)}
          className="mt-1 block rounded border border-border bg-surface px-3 py-1.5 text-content"
        >
          <option value="">Select a type</option>
          {assetTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">Name</span>
        <input
          required
          minLength={2}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">Serial number</span>
        <input
          value={serialNumber}
          onChange={(event) => setSerialNumber(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">
          Attributes (JSON — the type&rsquo;s required keys must be present, rule AM7)
        </span>
        <textarea
          rows={3}
          value={attributes}
          onChange={(event) => setAttributes(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 font-mono text-content"
        />
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">Warranty expires</span>
        <input
          type="date"
          value={warrantyExpiresAt}
          onChange={(event) => setWarrantyExpiresAt(event.target.value)}
          className="mt-1 block rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Registering…' : 'Register'}
      </button>
    </form>
  );
}

/** Attributes are free-form JSON; a malformed document is a client error, not a server one. */
function parseAttributes(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
