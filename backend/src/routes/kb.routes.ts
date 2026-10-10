import { Router } from 'express';
import {
  getArticleById,
  getArticles,
  getCategories,
  getStats,
  patchArticle,
  patchCategory,
  postArchive,
  postArticle,
  postCategory,
  postFeedback,
  postPublish,
  postReject,
  postSubmitReview,
  postUnarchive,
} from '../controllers/kb.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/authorize';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import {
  articleArchiveSchema,
  articleFeedbackSchema,
  articleRejectSchema,
  createArticleCategorySchema,
  createArticleSchema,
  listArticlesQuerySchema,
  updateArticleCategorySchema,
  updateArticleSchema,
} from '../validators/kb.validators';

/**
 * Knowledge-base routes (docs/27 §8, docs/11 §9).
 *
 * The route carries the coarse `kb:article:*` permission; the service applies the
 * visibility class (rule K3) and the lifecycle (rule K1 — a publisher may not approve
 * their own article). Mutations are CSRF-protected.
 *
 * Reading knowledge is `kb:article:read`, held by every tenant role (`docs/07` §3), so a
 * browser-browsing requester can self-serve — which is the point of a knowledge base.
 */
export const kbRouter = Router();

kbRouter.use(authenticate);

const read = requirePermission('kb:article:read');
const author = requirePermission('kb:article:author');
const publish = requirePermission('kb:article:publish');

kbRouter.get('/articles', read, validate({ query: listArticlesQuerySchema }), getArticles);
kbRouter.post(
  '/articles',
  author,
  csrfProtection,
  validate({ body: createArticleSchema }),
  postArticle,
);

kbRouter.get('/articles/:id', read, validate({ params: idParamsSchema }), getArticleById);
kbRouter.patch(
  '/articles/:id',
  author,
  csrfProtection,
  validate({ params: idParamsSchema, body: updateArticleSchema }),
  patchArticle,
);
kbRouter.post(
  '/articles/:id/submit',
  author,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postSubmitReview,
);
kbRouter.post(
  '/articles/:id/reject',
  publish,
  csrfProtection,
  validate({ params: idParamsSchema, body: articleRejectSchema }),
  postReject,
);
kbRouter.post(
  '/articles/:id/publish',
  publish,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postPublish,
);
kbRouter.post(
  '/articles/:id/archive',
  publish,
  csrfProtection,
  validate({ params: idParamsSchema, body: articleArchiveSchema }),
  postArchive,
);
kbRouter.post(
  '/articles/:id/unarchive',
  publish,
  csrfProtection,
  validate({ params: idParamsSchema }),
  postUnarchive,
);
kbRouter.post(
  '/articles/:id/feedback',
  read,
  csrfProtection,
  validate({ params: idParamsSchema, body: articleFeedbackSchema }),
  postFeedback,
);

kbRouter.get('/stats', read, getStats);
kbRouter.get('/categories', read, getCategories);
kbRouter.post(
  '/categories',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ body: createArticleCategorySchema }),
  postCategory,
);
kbRouter.patch(
  '/categories/:id',
  requirePermission('admin:config'),
  csrfProtection,
  validate({ params: idParamsSchema, body: updateArticleCategorySchema }),
  patchCategory,
);
