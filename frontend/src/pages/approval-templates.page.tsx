import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  createApprovalTemplate,
  listApprovalTemplates,
  type ApprovalMode,
} from '../api/approvals.api';
import { listItems } from '../api/catalog.api';
import { listAssignableRoles } from '../api/users.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Approval template administration (docs/26 §12, §10 — `admin:config`).
 *
 * A template binds a catalog item to an ordered set of steps, each with a mode and the
 * role whose active holders are snapshotted when a request enters approval (`26` §4). The
 * builder is intentionally explicit about the mode: an approver deciding a step needs to
 * know whether one approval or all of them are required.
 */

interface StepDraft {
  mode: ApprovalMode;
  approverRoleKey: string;
}

export function ApprovalTemplatesPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [catalogItemId, setCatalogItemId] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([{ mode: 'ANY', approverRoleKey: '' }]);

  const templates = useQuery({
    queryKey: ['approval-templates'],
    queryFn: ({ signal }) => listApprovalTemplates(signal),
  });

  const items = useQuery({
    queryKey: ['catalog', 'items', 'active'],
    queryFn: ({ signal }) => listItems({ status: 'ACTIVE', limit: 100 }, signal),
  });

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => listAssignableRoles(signal),
  });

  const create = useMutation({
    mutationFn: createApprovalTemplate,
    onSuccess: () => {
      setError(null);
      setName('');
      setSteps([{ mode: 'ANY', approverRoleKey: '' }]);
      void queryClient.invalidateQueries({ queryKey: ['approval-templates'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const canSubmit =
    catalogItemId !== '' &&
    name.trim().length >= 2 &&
    steps.every((step) => step.approverRoleKey !== '') &&
    new Set(steps.map((_, index) => index + 1)).size === steps.length;

  const updateStep = (index: number, patch: Partial<StepDraft>): void =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));

  return (
    <div className="space-y-10">
      <section aria-labelledby="templates-heading">
        <h1 id="templates-heading" className="text-2xl font-semibold text-content">
          Approval templates
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Bind a service to an ordered approval chain. A request for an item with
          <span className="font-mono"> requiresApproval </span>
          only enters approval when the item has an active template with at least one eligible
          approver per step.
        </p>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {/* Builder -------------------------------------------------------------- */}
      <section aria-labelledby="builder-heading" className="rounded-lg border border-border p-4">
        <h2 id="builder-heading" className="text-lg font-semibold text-content">
          New template
        </h2>

        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            create.mutate({
              catalogItemId,
              name: name.trim(),
              steps: steps.map((step, index) => ({
                stepOrder: index + 1,
                mode: step.mode,
                approverRoleKey: step.approverRoleKey,
              })),
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-content">Service</span>
              <select
                value={catalogItemId}
                onChange={(event) => setCatalogItemId(event.target.value)}
                disabled={items.isPending}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              >
                <option value="">Select an active service…</option>
                {(items.data?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span className="block font-medium text-content">Template name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              />
            </label>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-content">Steps</legend>
            {steps.map((step, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3">
                <span className="text-sm text-content-muted">Step {index + 1}</span>
                <label className="space-y-1 text-sm">
                  <span className="block text-content-muted">Mode</span>
                  <select
                    value={step.mode}
                    onChange={(event) =>
                      updateStep(index, { mode: event.target.value as ApprovalMode })
                    }
                    className="rounded border border-border bg-surface px-3 py-2 text-content"
                  >
                    <option value="ANY">Any approver</option>
                    <option value="ALL">All approvers</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="block text-content-muted">Approver role</span>
                  <select
                    value={step.approverRoleKey}
                    onChange={(event) => updateStep(index, { approverRoleKey: event.target.value })}
                    disabled={roles.isPending}
                    className="rounded border border-border bg-surface px-3 py-2 text-content"
                  >
                    <option value="">Select a role…</option>
                    {(roles.data?.items ?? []).map((role) => (
                      <option key={role.id} value={role.key}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </label>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
                    className="rounded border border-border px-3 py-2 text-sm text-content"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setSteps((current) => [...current, { mode: 'ANY', approverRoleKey: '' }])
              }
              className="rounded border border-border px-3 py-1.5 text-sm text-content"
            >
              Add step
            </button>
          </fieldset>

          <button
            type="submit"
            disabled={!canSubmit || create.isPending}
            className="rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create template'}
          </button>
        </form>
      </section>

      {/* Existing templates --------------------------------------------------- */}
      <section aria-labelledby="existing-heading">
        <h2 id="existing-heading" className="text-lg font-semibold text-content">
          Configured templates
        </h2>

        {templates.isPending && (
          <p role="status" className="mt-3 text-sm text-content-muted">
            Loading templates…
          </p>
        )}
        {templates.isSuccess && templates.data.items.length === 0 && (
          <p className="mt-3 text-sm text-content-muted">No templates configured yet.</p>
        )}

        {templates.isSuccess && templates.data.items.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {templates.data.items.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-content">{template.name}</p>
                  <p className="mt-0.5 text-xs text-content-muted">
                    {template.steps
                      .map(
                        (step) =>
                          `Step ${step.stepOrder}: ${step.mode === 'ALL' ? 'all' : 'any'} ${step.approverRoleKey}`,
                      )
                      .join(' · ')}
                  </p>
                </div>
                <StatusBadge tone={template.isActive ? 'success' : 'neutral'}>
                  {template.isActive ? 'ACTIVE' : 'INACTIVE'}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
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
