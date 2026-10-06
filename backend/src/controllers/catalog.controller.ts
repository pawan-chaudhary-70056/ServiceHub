import type { Request, Response } from 'express';
import {
  activateItem,
  createCategory,
  createItem,
  getItem,
  listCategoryTree,
  listItems,
  retireItem,
  updateCategory,
  updateItem,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  CreateCatalogItemInput,
  CreateCategoryInput,
  UpdateCatalogItemInput,
  UpdateCategoryInput,
} from '../validators/catalog.validators';
import { requestMeta } from './support';

/**
 * Service catalog endpoints (docs/21 §8, docs/11 §9).
 *
 * The route carries the coarse permission (`catalog:read` / `catalog:manage`) and the
 * service asserts the same permission again plus the tenant scope (docs/07 §6). A
 * requester's list is forced ACTIVE-only inside the service, so this layer does not have
 * to remember the rule — the surface cannot accidentally expose drafts.
 */

/** `GET /catalog/categories` — the flattened category tree (`catalog:read`). */
export async function getCategories(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<unknown, unknown, { includeInactive: boolean }>(res);
  const items = await listCategoryTree(req.actor, query);
  res.status(200).json({ items });
}

/** `POST /catalog/categories` — creates a category (`catalog:manage`). */
export async function postCategory(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateCategoryInput>(res);
  const category = await createCategory(body, req.actor, requestMeta(req));
  res.status(201).json({ category });
}

/** `PATCH /catalog/categories/{id}` — edits or re-parents a category (`catalog:manage`). */
export async function patchCategory(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<UpdateCategoryInput, { id: string }>(res);
  const category = await updateCategory(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ category });
}

/** `GET /catalog/items` — cursor-paginated items, ACTIVE-only for non-managers. */
export async function getItems(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { query } = validated<
    unknown,
    unknown,
    { limit: number; cursor?: string; status?: string; categoryId?: string }
  >(res);
  const page = await listItems(query, req.actor);
  res.status(200).json(page);
}

/** `GET /catalog/items/{id}` — item detail with its field definitions. */
export async function getItemById(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const item = await getItem(params.id, req.actor);
  res.status(200).json({ item });
}

/** `POST /catalog/items` — creates a DRAFT item with its fields (`catalog:manage`). */
export async function postItem(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body } = validated<CreateCatalogItemInput>(res);
  const item = await createItem(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/catalog/items/${item.id}`);
  res.status(201).json({ item });
}

/** `PATCH /catalog/items/{id}` — edits an item and/or replaces its fields. */
export async function patchItem(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { body, params } = validated<UpdateCatalogItemInput, { id: string }>(res);
  const item = await updateItem(params.id, body, req.actor, requestMeta(req));
  res.status(200).json({ item });
}

/** `POST /catalog/items/{id}/activate` — enforces rule C1 before going live. */
export async function postActivateItem(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const item = await activateItem(params.id, req.actor, requestMeta(req));
  res.status(200).json({ item });
}

/** `POST /catalog/items/{id}/retire` — retires an item without touching its history. */
export async function postRetireItem(req: Request, res: Response): Promise<void> {
  if (!req.actor) {
    throw new UnauthenticatedError();
  }
  const { params } = validated<unknown, { id: string }>(res);
  const item = await retireItem(params.id, req.actor, requestMeta(req));
  res.status(200).json({ item });
}
