import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  activateItem,
  createCategory,
  createItem,
  getItem,
  listCategories,
  listItems,
  retireItem,
  updateItem,
  type CatalogFieldInput,
  type CatalogFieldType,
  type CatalogItemDetail,
  type CatalogItemField,
  type CatalogItemSummary,
  type Priority,
} from '../api/catalog.api';
import { listPolicies } from '../api/sla.api';
import { listTeams } from '../api/teams.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';

/**
 * Service catalog (docs/21 §9). One surface for a requester and an administrator:
 * the manage controls appear only when the caller holds `catalog:manage`, and the server
 * enforces the same permission independently (docs/07 §6).
 *
 * Copy avoids ITSM jargon (docs/16 §10): "service" not "CI class", "what you need" not
 * "intake contract".
 */

const FIELD_TYPES: CatalogFieldType[] = [
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'DATE',
  'DATETIME',
  'SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'FILE',
  'USER',
];

const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

interface FieldDraft {
  key: string;
  label: string;
  fieldType: CatalogFieldType;
  isRequired: boolean;
  options: string;
}

const emptyField = (): FieldDraft => ({
  key: '',
  label: '',
  fieldType: 'TEXT',
  isRequired: false,
  options: '',
});

export function CatalogPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('catalog:manage');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['catalog', 'categories', { includeInactive: canManage }],
    queryFn: ({ signal }) => listCategories({ includeInactive: canManage }, signal),
  });

  const items = useQuery({
    queryKey: [
      'catalog',
      'items',
      { categoryId: selectedCategory, status: canManage ? 'ALL' : 'ACTIVE' },
    ],
    queryFn: ({ signal }) =>
      listItems(
        {
          categoryId: selectedCategory ?? undefined,
          ...(canManage ? {} : { status: 'ACTIVE' }),
        },
        signal,
      ),
  });

  const detail = useQuery({
    queryKey: ['catalog', 'item', selectedItemId],
    queryFn: ({ signal }) => getItem(selectedItemId as string, signal),
    enabled: selectedItemId !== null,
    retry: false,
  });

  const categoryTree = useMemo(() => buildTree(categories.data?.items ?? []), [categories.data]);

  return (
    <div className="space-y-10">
      <section aria-labelledby="catalog-heading">
        <h1 id="catalog-heading" className="text-2xl font-semibold text-content">
          Service catalog
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Browse the services you can request.{' '}
          {canManage && 'As an administrator you can also define categories and services.'}
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

      <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
        {/* Categories ------------------------------------------------------- */}
        <section aria-labelledby="categories-heading" className="space-y-3">
          <h2 id="categories-heading" className="text-lg font-semibold text-content">
            Categories
          </h2>

          {categories.isPending && (
            <p role="status" className="text-sm text-content-muted">
              Loading…
            </p>
          )}
          {categories.isError && (
            <p role="alert" className="text-sm text-danger">
              {messageFor(categories.error)}
            </p>
          )}

          <ul className="space-y-1 text-sm">
            <li>
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                className={`w-full rounded px-2 py-1 text-left ${selectedCategory === null ? 'bg-brand/10 text-content' : 'text-content-muted hover:text-content'}`}
              >
                All services
              </button>
            </li>
            {categoryTree.map((node) => (
              <li key={node.id} style={{ paddingLeft: `${node.depth * 12}px` }}>
                <button
                  type="button"
                  onClick={() => setSelectedCategory(node.id)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${
                    selectedCategory === node.id
                      ? 'bg-brand/10 text-content'
                      : 'text-content-muted hover:text-content'
                  }`}
                >
                  <span>
                    {node.name}
                    {!node.isActive && <span className="ml-1 text-xs">(inactive)</span>}
                  </span>
                  <span className="text-xs text-content-muted">{node.itemCount}</span>
                </button>
              </li>
            ))}
          </ul>

          {canManage && <CreateCategoryForm onError={setActionError} />}
        </section>

        {/* Items ------------------------------------------------------------ */}
        <section aria-labelledby="items-heading" className="space-y-4">
          <h2 id="items-heading" className="text-lg font-semibold text-content">
            Services
          </h2>

          {items.isPending && (
            <p role="status" className="text-sm text-content-muted">
              Loading services…
            </p>
          )}
          {items.isError && (
            <p role="alert" className="text-sm text-danger">
              {messageFor(items.error)}
            </p>
          )}
          {items.isSuccess && items.data.items.length === 0 && (
            <p className="text-sm text-content-muted">
              No services here yet. {canManage ? 'Create one below.' : 'Try another category.'}
            </p>
          )}

          {items.isSuccess && items.data.items.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.data.items.map((item) => (
                <CatalogItemRow
                  key={item.id}
                  item={item}
                  selected={selectedItemId === item.id}
                  onSelect={() => setSelectedItemId(item.id)}
                />
              ))}
            </ul>
          )}

          {selectedItemId && (
            <ItemDetail
              item={detail.data?.item}
              isLoading={detail.isPending}
              error={detail.isError ? detail.error : null}
              canManage={canManage}
              onError={setActionError}
            />
          )}

          {canManage && categories.isSuccess && (
            <CreateItemForm
              categories={categories.data.items}
              onError={setActionError}
              onCreated={(id) => setSelectedItemId(id)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CatalogItemRow({
  item,
  selected,
  onSelect,
}: {
  item: CatalogItemSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-surface-muted ${selected ? 'bg-surface-muted' : ''}`}
      >
        <span>
          <span className="font-medium text-content">{item.name}</span>
          <span className="ml-2 text-xs text-content-muted">{item.categoryName}</span>
          {item.description && (
            <span className="mt-0.5 block max-w-2xl text-sm text-content-muted">
              {item.description}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={toneFor(item.status)}>{item.status}</StatusBadge>
          <span className="text-xs text-content-muted">{item.defaultPriority}</span>
        </span>
      </button>
    </li>
  );
}

function ItemDetail({
  item,
  isLoading,
  error,
  canManage,
  onError,
}: {
  item: CatalogItemDetail | undefined;
  isLoading: boolean;
  error: unknown;
  canManage: boolean;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const activate = useMutation({
    mutationFn: (id: string) => activateItem(id),
    onSuccess: () => {
      onError(null);
      invalidate();
    },
    onError: (mutationError) => onError(messageFor(mutationError)),
  });

  const retire = useMutation({
    mutationFn: (id: string) => retireItem(id),
    onSuccess: () => {
      onError(null);
      invalidate();
    },
    onError: (mutationError) => onError(messageFor(mutationError)),
  });

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Loading service…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {messageFor(error)}
      </p>
    );
  }
  if (!item) {
    return null;
  }

  return (
    <section aria-labelledby="item-detail-heading" className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="item-detail-heading" className="text-lg font-semibold text-content">
            {item.name}
          </h3>
          <p className="text-sm text-content-muted">
            {item.categoryName} · default priority {item.defaultPriority}
            {item.requiresApproval && ' · needs approval'}
          </p>
        </div>

        {canManage && (
          <div className="flex gap-2">
            {/* Editing is offered for every status, not only an active item: fixing a
                draft before it goes live is the common case (docs/21 §9). The server
                re-checks `catalog:manage` and reconciles the field definitions, keeping
                C9 in force (`21` §5). */}
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              aria-expanded={editing}
              className="rounded border border-border px-3 py-1 text-sm text-content"
            >
              {editing ? 'Close editor' : 'Edit service'}
            </button>
            {item.status !== 'ACTIVE' && (
              <button
                type="button"
                disabled={activate.isPending}
                onClick={() => activate.mutate(item.id)}
                className="rounded bg-brand px-3 py-1 text-sm text-content-inverted disabled:opacity-60"
              >
                {activate.isPending ? 'Activating…' : 'Activate'}
              </button>
            )}
            {item.status !== 'RETIRED' && (
              <button
                type="button"
                disabled={retire.isPending}
                onClick={() => retire.mutate(item.id)}
                className="rounded border border-border px-3 py-1 text-sm text-content disabled:opacity-60"
              >
                {retire.isPending ? 'Retiring…' : 'Retire'}
              </button>
            )}
          </div>
        )}
      </div>

      {item.description && <p className="mt-3 text-content-muted">{item.description}</p>}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">
            Ways it is measured
          </dt>
          <dd className="text-sm text-content">
            {item.defaultSlaPolicy?.name ?? 'No SLA policy set'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">
            Fulfilled by
          </dt>
          <dd className="text-sm text-content">{item.fulfilmentTeam?.name ?? 'No team set'}</dd>
        </div>
      </dl>

      {canManage && editing && (
        <EditItemForm item={item} onError={onError} onDone={() => setEditing(false)} />
      )}

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
          What we will ask you
        </p>
        {item.fields.length === 0 ? (
          <p className="mt-1 text-sm text-content-muted">
            No extra details are needed for this service.
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm text-content">
            {item.fields.map((field) => (
              <li key={field.id}>
                {field.label}
                {field.isRequired && <span className="ml-1 text-danger">*</span>}
                <span className="ml-2 text-xs text-content-muted">
                  {labelForFieldType(field.fieldType)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function CreateCategoryForm({ onError }: { onError: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');

  const categories = useQuery({
    queryKey: ['catalog', 'categories', { includeInactive: true }],
    queryFn: ({ signal }) => listCategories({ includeInactive: true }, signal),
  });

  const create = useMutation({
    mutationFn: () => createCategory({ name, parentId: parentId || null }),
    onSuccess: () => {
      onError(null);
      setName('');
      setParentId('');
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <form
      className="space-y-2 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <p className="text-sm font-medium text-content">New category</p>
      <input
        aria-label="Category name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Category name"
        className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-content"
      />
      <select
        aria-label="Parent category"
        value={parentId}
        onChange={(event) => setParentId(event.target.value)}
        className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-content"
      >
        <option value="">Top level</option>
        {(categories.data?.items ?? []).map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={create.isPending || !name.trim()}
        className="rounded bg-brand px-3 py-1 text-sm text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Creating…' : 'Add category'}
      </button>
    </form>
  );
}

function CreateItemForm({
  categories,
  onError,
  onCreated,
}: {
  categories: Array<{ id: string; name: string }>;
  onError: (message: string | null) => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [policyId, setPolicyId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [fields, setFields] = useState<FieldDraft[]>([]);

  const policies = useQuery({
    queryKey: ['sla', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
    enabled: open,
    retry: false,
  });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => listTeams(signal),
    enabled: open,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createItem({
        categoryId,
        name,
        description: description || null,
        defaultPriority: priority,
        defaultSlaPolicyId: policyId || null,
        fulfilmentTeamId: teamId || null,
        requiresApproval,
        fields: toCatalogFieldInputs(fields),
      }),
    onSuccess: (result) => {
      onError(null);
      setName('');
      setDescription('');
      setFields([]);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onCreated(result.item.id);
    },
    onError: (error) => onError(messageFor(error)),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-border px-3 py-2 text-sm text-content"
      >
        + New service
      </button>
    );
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && categoryId) create.mutate();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-content">New service</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-content-muted">
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Category</span>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">Select…</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="block font-medium text-content">Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Default priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">SLA policy</span>
          <select
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">None</option>
            {(policies.data?.items ?? []).map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Fulfilment team</span>
          <select
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">None</option>
            {(teams.data?.items ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(event) => setRequiresApproval(event.target.checked)}
          />
          <span className="text-content">Requires approval before fulfilment</span>
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-content">Form fields</p>
        {fields.map((field, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
            <input
              aria-label={`Field ${index + 1} key`}
              value={field.key}
              onChange={(event) =>
                updateField(fields, setFields, index, { key: event.target.value })
              }
              placeholder="key"
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            />
            <input
              aria-label={`Field ${index + 1} label`}
              value={field.label}
              onChange={(event) =>
                updateField(fields, setFields, index, { label: event.target.value })
              }
              placeholder="Label"
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            />
            <select
              aria-label={`Field ${index + 1} type`}
              value={field.fieldType}
              onChange={(event) =>
                updateField(fields, setFields, index, {
                  fieldType: event.target.value as CatalogFieldType,
                })
              }
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={field.isRequired}
                onChange={(event) =>
                  updateField(fields, setFields, index, { isRequired: event.target.checked })
                }
              />
              req
            </label>
            <button
              type="button"
              onClick={() => setFields(fields.filter((_, i) => i !== index))}
              className="text-sm text-content-muted"
            >
              Remove
            </button>
            {(field.fieldType === 'SELECT' || field.fieldType === 'MULTI_SELECT') && (
              <input
                aria-label={`Field ${index + 1} options`}
                value={field.options}
                onChange={(event) =>
                  updateField(fields, setFields, index, { options: event.target.value })
                }
                placeholder="Options, comma separated"
                className="rounded border border-border bg-surface px-2 py-1 text-sm text-content sm:col-span-5"
              />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields([...fields, emptyField()])}
          className="rounded border border-border px-3 py-1 text-sm text-content"
        >
          + Add field
        </button>
      </div>

      <button
        type="submit"
        disabled={create.isPending || !name.trim() || !categoryId}
        className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Creating…' : 'Create service'}
      </button>
    </form>
  );
}

function EditItemForm({
  item,
  onError,
  onDone,
}: {
  item: CatalogItemDetail;
  onError: (message: string | null) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [priority, setPriority] = useState<Priority>(item.defaultPriority);
  const [policyId, setPolicyId] = useState(item.defaultSlaPolicyId ?? '');
  const [teamId, setTeamId] = useState(item.fulfilmentTeamId ?? '');
  const [requiresApproval, setRequiresApproval] = useState(item.requiresApproval);
  const [fields, setFields] = useState<FieldDraft[]>(() => draftsFromFields(item.fields));

  const policies = useQuery({
    queryKey: ['sla', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
    retry: false,
  });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) => listTeams(signal),
    retry: false,
  });

  const update = useMutation({
    // The field list is sent in full, because the server reconciles it as a **replace**
    // (`catalog.service.ts`): a definition omitted here is a definition removed. Sending a
    // patch of only the changed field would silently drop the rest (docs/21 §5 C9).
    mutationFn: () =>
      updateItem(item.id, {
        name,
        description: description || null,
        defaultPriority: priority,
        defaultSlaPolicyId: policyId || null,
        fulfilmentTeamId: teamId || null,
        requiresApproval,
        fields: toCatalogFieldInputs(fields),
      }),
    onSuccess: () => {
      onError(null);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onDone();
    },
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <form
      className="mt-4 space-y-4 rounded border border-border bg-surface-muted p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) update.mutate();
      }}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-base font-semibold text-content">Edit service</h4>
        <button type="button" onClick={onDone} className="text-sm text-content-muted">
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Default priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="block font-medium text-content">Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">SLA policy</span>
          <select
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">None</option>
            {(policies.data?.items ?? []).map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Fulfilment team</span>
          <select
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          >
            <option value="">None</option>
            {(teams.data?.items ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(event) => setRequiresApproval(event.target.checked)}
          />
          <span className="text-content">Requires approval before fulfilment</span>
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-content">Form fields</p>
        <p className="text-xs text-content-muted">
          A saved change applies to new requests. Answers already captured keep the wording they
          were given — a field definition is snapshotted into the request at creation.
        </p>
        {fields.map((field, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
            <input
              aria-label={`Field ${index + 1} key`}
              value={field.key}
              onChange={(event) =>
                updateField(fields, setFields, index, { key: event.target.value })
              }
              placeholder="key"
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            />
            <input
              aria-label={`Field ${index + 1} label`}
              value={field.label}
              onChange={(event) =>
                updateField(fields, setFields, index, { label: event.target.value })
              }
              placeholder="Label"
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            />
            <select
              aria-label={`Field ${index + 1} type`}
              value={field.fieldType}
              onChange={(event) =>
                updateField(fields, setFields, index, {
                  fieldType: event.target.value as CatalogFieldType,
                })
              }
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-content"
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={field.isRequired}
                onChange={(event) =>
                  updateField(fields, setFields, index, { isRequired: event.target.checked })
                }
              />
              req
            </label>
            <button
              type="button"
              onClick={() => setFields(fields.filter((_, i) => i !== index))}
              className="text-sm text-content-muted"
            >
              Remove
            </button>
            {(field.fieldType === 'SELECT' || field.fieldType === 'MULTI_SELECT') && (
              <input
                aria-label={`Field ${index + 1} options`}
                value={field.options}
                onChange={(event) =>
                  updateField(fields, setFields, index, { options: event.target.value })
                }
                placeholder="Options, comma separated"
                className="rounded border border-border bg-surface px-2 py-1 text-sm text-content sm:col-span-5"
              />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields([...fields, emptyField()])}
          className="rounded border border-border px-3 py-1 text-sm text-content"
        >
          + Add field
        </button>
      </div>

      <button
        type="submit"
        disabled={update.isPending || !name.trim()}
        className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
      >
        {update.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads a stored field's options into the comma-separated text the editor works in.
 * A non-array (or absent) `options` is not an error — only the choice types have any.
 */
function optionText(options: unknown): string {
  return Array.isArray(options)
    ? options.filter((option): option is string => typeof option === 'string').join(', ')
    : '';
}

/** Turns an item's saved definitions into editor drafts, so editing starts from truth. */
function draftsFromFields(fields: CatalogItemField[]): FieldDraft[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    fieldType: field.fieldType,
    isRequired: field.isRequired,
    options: optionText(field.options),
  }));
}

/**
 * Drafts to API input. Shared by create and edit so the two cannot drift: a field the
 * editor can add but the payload drops would be a silent data loss.
 */
function toCatalogFieldInputs(fields: FieldDraft[]): CatalogFieldInput[] {
  return fields
    .filter((field) => field.key.trim() && field.label.trim())
    .map((field) => ({
      key: field.key.trim(),
      label: field.label.trim(),
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      ...(field.fieldType === 'SELECT' || field.fieldType === 'MULTI_SELECT'
        ? {
            options: field.options
              .split(',')
              .map((option) => option.trim())
              .filter(Boolean),
          }
        : {}),
    }));
}

function updateField(
  fields: FieldDraft[],
  setFields: (fields: FieldDraft[]) => void,
  index: number,
  patch: Partial<FieldDraft>,
): void {
  setFields(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
}

function buildTree(
  categories: Array<{
    id: string;
    name: string;
    parentId: string | null;
    isActive: boolean;
    itemCount: number;
  }>,
): Array<{ id: string; name: string; isActive: boolean; itemCount: number; depth: number }> {
  const byParent = new Map<string | null, typeof categories>();
  for (const category of categories) {
    const list = byParent.get(category.parentId) ?? [];
    list.push(category);
    byParent.set(category.parentId, list);
  }

  const flat: Array<{
    id: string;
    name: string;
    isActive: boolean;
    itemCount: number;
    depth: number;
  }> = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const category of byParent.get(parentId) ?? []) {
      flat.push({
        id: category.id,
        name: category.name,
        isActive: category.isActive,
        itemCount: category.itemCount,
        depth,
      });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);
  return flat;
}

function toneFor(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'DRAFT') return 'warning';
  return 'neutral';
}

function labelForFieldType(type: CatalogFieldType): string {
  return type
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errors.length > 0) {
      return `${error.message} (${error.errors.map((detail) => detail.message).join('; ')})`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
