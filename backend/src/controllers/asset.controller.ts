import type { Request, Response } from 'express';
import {
  assignAsset,
  createAssetRecord,
  createAssetTypeDefinition,
  disposeAsset,
  getAsset,
  getAssetByTag,
  getAssetStats,
  listAssetAssignments,
  listAssetsPage,
  listAssetTypeDefinitions,
  markAssetInRepair,
  retireAsset,
  returnAsset,
  updateAssetRecord,
  updateAssetTypeDefinition,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  AssignAssetInput,
  CreateAssetInput,
  CreateAssetTypeInput,
  UpdateAssetInput,
} from '../validators/asset.validators';
import { requestMeta } from './support';

/**
 * Asset endpoints (docs/28 §8, docs/11 §9).
 *
 * The route carries the coarse `asset:*` permission; the service applies the holder scope
 * (`asset:read.own`), the lifecycle rules and the assignment invariants. A caller who may
 * not read an asset receives `404`, not `403` (`docs/17`).
 *
 * **Linking is not ownership transfer** (`docs/28` §7): no endpoint here changes a holder
 * implicitly; only `assign`/`return` do, and both are audited.
 */

/** `GET /assets` — holder-scoped, cursor-paginated register. */
export async function getAssets(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<
    unknown,
    unknown,
    {
      limit: number;
      cursor?: string;
      state?: 'PROCURED' | 'IN_STOCK' | 'ASSIGNED' | 'IN_REPAIR' | 'RETIRED' | 'DISPOSED';
      assetTypeId?: string;
      holderUserId?: string;
    }
  >(res);
  res.status(200).json(await listAssetsPage(query, req.actor));
}

/** `POST /assets` — registers an asset (`201`); the tag is allocated server-side. */
export async function postAsset(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateAssetInput>(res);
  const asset = await createAssetRecord(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/assets/${asset.id}`);
  res.status(201).json({ asset });
}

/** `GET /assets/{id}` — accepts the opaque id or the human-readable `AST-000123` tag. */
export async function getAssetById(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  const asset = params.id.startsWith('AST-')
    ? await getAssetByTag(params.id, req.actor)
    : await getAsset(params.id, req.actor);
  res.status(200).json({ asset });
}

/** `PATCH /assets/{id}` — field edits; ASSIGNED and DISPOSED are not editable here. */
export async function patchAsset(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<UpdateAssetInput, { id: string }>(res);
  res
    .status(200)
    .json({ asset: await updateAssetRecord(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /assets/{id}/assign` — opens an assignment; refused when one is open (AM1). */
export async function postAssign(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<AssignAssetInput, { id: string }>(res);
  res.status(200).json({ asset: await assignAsset(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /assets/{id}/return` — closes the open assignment (`returnedAt` set, row kept). */
export async function postReturn(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ notes?: string | null }, { id: string }>(res);
  res.status(200).json({ asset: await returnAsset(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /assets/{id}/repair` — moves into repair, closing any open assignment. */
export async function postRepair(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ reason?: string | null }, { id: string }>(res);
  res
    .status(200)
    .json({ asset: await markAssetInRepair(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /assets/{id}/retire` — closes open assignments; never a delete (AM4/AM5). */
export async function postRetire(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ reason?: string | null }, { id: string }>(res);
  res.status(200).json({ asset: await retireAsset(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /assets/{id}/dispose` — RETIRED → DISPOSED, terminal. */
export async function postDispose(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ reason?: string | null }, { id: string }>(res);
  res.status(200).json({ asset: await disposeAsset(params.id, body, req.actor, requestMeta(req)) });
}

/** `GET /assets/{id}/assignments` — the full interval history (`docs/28` §8). */
export async function getAssignments(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res.status(200).json({ items: await listAssetAssignments(params.id, req.actor) });
}

/** `GET /assets/stats` — counts by lifecycle state (`docs/28` §9). */
export async function getStats(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json(await getAssetStats(req.actor));
}

/** `GET /admin/asset-types` — the type definitions, read by any asset reader. */
export async function getAssetTypes(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ items: await listAssetTypeDefinitions(req.actor) });
}

/** `POST /admin/asset-types` — administrator only. */
export async function postAssetType(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateAssetTypeInput>(res);
  const assetType = await createAssetTypeDefinition(body, req.actor, requestMeta(req));
  res.status(201).json({ assetType });
}

/** `PATCH /admin/asset-types/{id}` — administrator only. */
export async function patchAssetType(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<
    {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      attributeSchema?: Record<string, unknown>;
    },
    { id: string }
  >(res);
  res.status(200).json({
    assetType: await updateAssetTypeDefinition(params.id, body, req.actor, requestMeta(req)),
  });
}
