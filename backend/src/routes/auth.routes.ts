import { Router } from 'express';
import { config } from '../config';
import {
  getMe,
  postAcceptInvitation,
  postForgotPassword,
  postLogin,
  postLogout,
  postResetPassword,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/authenticate';
import { csrfProtection } from '../middlewares/csrf';
import { createRateLimiter } from '../middlewares/rate-limit';
import { validate } from '../middlewares/validate';
import {
  acceptInvitationSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from '../validators/auth.validators';

/**
 * Authentication routes (docs/11 §9, docs/06).
 *
 * The split is deliberate: the credential endpoints (login, forgot, reset,
 * accept-invitation) are public and carry the **strictest** rate-limit bucket; logout
 * and `me` are authenticated. `logout` is state-changing and therefore CSRF-protected,
 * while `me` is a safe read.
 *
 * The limiter counts per source address, because there is no identity yet — a per-caller
 * bucket on `/auth/login` would let one account's failures exhaust another's allowance.
 */
export const authRouter = Router();

const credentialLimiter = createRateLimiter({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => req.ip ?? 'unknown',
  message: 'Too many authentication attempts. Please try again shortly.',
  // Credential surfaces fail CLOSED when the limiter cannot count (docs/33 §6): running
  // an un-metered brute-force is worse than making the caller retry.
  failureMode: 'closed',
});

authRouter.post('/login', credentialLimiter, validate({ body: loginSchema }), postLogin);
authRouter.post(
  '/forgot',
  credentialLimiter,
  validate({ body: forgotPasswordSchema }),
  postForgotPassword,
);
authRouter.post(
  '/reset',
  credentialLimiter,
  validate({ body: resetPasswordSchema }),
  postResetPassword,
);
authRouter.post(
  '/accept-invitation',
  credentialLimiter,
  validate({ body: acceptInvitationSchema }),
  postAcceptInvitation,
);

authRouter.post('/logout', authenticate, csrfProtection, postLogout);
authRouter.get('/me', authenticate, getMe);
