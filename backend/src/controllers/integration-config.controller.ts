import type { Request, Response } from 'express';
import {
  listIntegrationConfigForCaller,
  testIntegrationForCaller,
  updateIntegrationConfigForCaller,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type { UpdateIntegrationConfigBody } from '../validators/integration-config.validators';
import { requestMeta } from './support';

/**
 * Integration configuration endpoints (`docs/32` §11/§12/§13).
 *
 * Read is `integration:read`; write and test are `admin:config` — the grant the document names
 * for "Configure integrations (audited)". The service enforces both as well, so a non-HTTP
 * caller is covered; the handler only translates.
 *
 * The credential never appears in a response or a request body: the API exposes a *reference*
 * and whether a runtime adapter is present, which is all an operator needs to diagnose a
 * misconfiguration without the platform being able to read the secret.
 */

/** `GET /admin/integrations/config` — the catalogue merged with this tenant's settings. */
export async function getIntegrationConfig(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ integrations: await listIntegrationConfigForCaller(req.actor) });
}

/** `PATCH /admin/integrations/config/{key}` — configures one integration; audited. */
export async function patchIntegrationConfig(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<UpdateIntegrationConfigBody, { key: string }>(res);
  const integration = await updateIntegrationConfigForCaller(
    params.key,
    body,
    req.actor,
    requestMeta(req),
  );
  res.status(200).json({ integration });
}

/** `POST /admin/integrations/config/{key}/test` — a bounded connectivity check; audited. */
export async function postIntegrationConfigTest(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { key: string }>(res);
  const result = await testIntegrationForCaller(params.key, req.actor, requestMeta(req));
  res.status(200).json({ result });
}
