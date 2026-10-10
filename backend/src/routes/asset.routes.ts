import { Router } from 'express';
import {
  getAssetById,
  getAssetTypes,
  getAssignments,
  getAssets,
  getStats,
  patchAsset,
  patchAssetType,
  postAsset,
  postAssetType,
  postAssign,
  postDispose,
  postRepair,
  postRetire,
  postReturn,
} from '../controllers/asset.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  assetNotesSchema,
  assignAssetSchema,
  createAssetSchema,
  createAssetTypeSchema,
  listAssetsQuerySchema,
  updateAssetSchema,
  updateAssetTypeSchema,
} from '../validators/asset.validators';

/**
 * Asset routes (docs/28 §8, docs/11 §9).
 *
 * Reading is one capability expressed as two grants (`docs/07` §3): a holder holds
 * `asset:read.own`, an asset manager/lead/admin/auditor `asset:read.any`. The service
 * applies the object-level scope; a caller who may not read an asset receives 404.
 * Mutations are CSRF-protected.
 */
export const assetRouter = Router();

assetRouter.use(authenticate);

const read = requireAnyPermission(['asset:read.own', 'asset:read.any']);
const manage = requirePermission('asset:manage');
const assign = requirePermission('asset:assign');

assetRouter.get('/', read, validate({ query: listAssetsQuerySchema }), getAssets);
// Must precede `/:id` so `stats` is never parsed as an identifier.
assetRouter.get('/stats', read, getStats);
assetRouter.post('/', manage, csrfProtection, validate({ body: createAssetSchema }), postAsset);

assetRouter.get('/:id', read, validate({ params: idParamsSchema }), getAssetById);
assetRouter.patch(
  '/:id',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateAssetSchema }),
  patchAsset,
);
assetRouter.get('/:id/assignments', read, validate({ params: idParamsSchema }), getAssignments);
assetRouter.post(
  '/:id/assign',
  assign,
  csrfProtection,
  validate({ params: idParamsSchema, body: assignAssetSchema }),
  postAssign,
);
assetRouter.post(
  '/:id/return',
  assign,
  csrfProtection,
  validate({ params: idParamsSchema, body: assetNotesSchema }),
  postReturn,
);
assetRouter.post(
  '/:id/repair',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: assetNotesSchema }),
  postRepair,
);
assetRouter.post(
  '/:id/retire',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: assetNotesSchema }),
  postRetire,
);
assetRouter.post(
  '/:id/dispose',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: assetNotesSchema }),
  postDispose,
);

/**
 * Asset-type administration (docs/28 §8: `/admin/asset-types`).
 *
 * Mounted at `/admin` alongside the approval-template routes; Express composes the two
 * routers under one prefix, and each declares its own paths.
 */
export const assetTypeRouter = Router();

assetTypeRouter.use(authenticate);

assetTypeRouter.get(
  '/asset-types',
  requireAnyPermission(['asset:read.own', 'asset:read.any']),
  getAssetTypes,
);
assetTypeRouter.post(
  '/asset-types',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ body: createAssetTypeSchema }),
  postAssetType,
);
assetTypeRouter.patch(
  '/asset-types/:id',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ params: idParamsSchema, body: updateAssetTypeSchema }),
  patchAssetType,
);
