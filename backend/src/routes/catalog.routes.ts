import { Router } from 'express';
import {
  getCategories,
  getItemById,
  getItems,
  patchCategory,
  patchItem,
  postActivateItem,
  postCategory,
  postItem,
  postRetireItem,
} from '../controllers/catalog.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  createCatalogItemSchema,
  createCategorySchema,
  listCatalogItemsQuerySchema,
  listCategoriesQuerySchema,
  updateCatalogItemSchema,
  updateCategorySchema,
} from '../validators/catalog.validators';

/**
 * Service catalog routes (docs/21 §8, docs/11 §9).
 *
 * Reads carry `catalog:read` (every authenticated member); writes carry `catalog:manage`
 * (administrator). The service re-checks both permission and tenant scope, and forces a
 * non-manager's item list to ACTIVE-only, so the route cannot widen the data a requester
 * sees (docs/07 §6). Mutations are CSRF-protected; reads are safe methods.
 */
export const catalogRouter = Router();

catalogRouter.use(authenticate);

const read = requirePermission('catalog:read');
const manage = requirePermission('catalog:manage');

catalogRouter.get(
  '/categories',
  read,
  validate({ query: listCategoriesQuerySchema }),
  getCategories,
);
catalogRouter.post(
  '/categories',
  manage,
  csrfProtection,
  validate({ body: createCategorySchema }),
  postCategory,
);
catalogRouter.patch(
  '/categories/:id',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateCategorySchema }),
  patchCategory,
);

catalogRouter.get('/items', read, validate({ query: listCatalogItemsQuerySchema }), getItems);
catalogRouter.post(
  '/items',
  manage,
  csrfProtection,
  validate({ body: createCatalogItemSchema }),
  postItem,
);
catalogRouter.get('/items/:id', read, validate({ params: idParamsSchema }), getItemById);
catalogRouter.patch(
  '/items/:id',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateCatalogItemSchema }),
  patchItem,
);
catalogRouter.post(
  '/items/:id/activate',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postActivateItem,
);
catalogRouter.post(
  '/items/:id/retire',
  manage,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postRetireItem,
);
