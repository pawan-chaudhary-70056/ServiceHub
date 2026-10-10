import { Router } from 'express';
import {
  getAttachmentContent,
  getAttachments,
  postAttachment,
} from '../controllers/attachment.controller';
import { authenticate } from '../middlewares/authenticate';
import { csrfProtection } from '../middlewares/csrf';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../validators';
import { attachmentListQuerySchema } from '../validators/attachment.validators';

/**
 * Attachment routes (docs/19 §7, docs/11 §9).
 *
 * No route-level permission is declared, and that is deliberate: an attachment has no
 * visibility of its own (`07` §4) — it inherits the parent's. A coarse grant here would
 * be wrong in both directions (too wide for a record the caller cannot see, too narrow
 * for a requester attaching to their own request), so the service resolves the parent
 * and applies the parent's own rule. Every outcome for an invisible parent is `404`,
 * never `403` (`17` §5).
 *
 * The upload route parses multipart itself; `validate({ body })` is therefore not
 * attached — the controller validates the parsed fields with the same Zod schema.
 */
export const attachmentRouter = Router();

attachmentRouter.use(authenticate);

attachmentRouter.get('/', validate({ query: attachmentListQuerySchema }), getAttachments);

attachmentRouter.post('/', csrfProtection, postAttachment);

attachmentRouter.get('/:id/content', validate({ params: idParamsSchema }), getAttachmentContent);
