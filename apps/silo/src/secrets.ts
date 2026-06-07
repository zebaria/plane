/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shared secret-store kit. Provider-agnostic plumbing for reading/writing
 * secrets from AWS Secrets Manager, used by each integration's own loader
 * (see slack/secrets.ts, github/secrets.ts). Per the corpinfra convention:
 * dev secrets live in us-east-1 under /dev/<name>; prod under us-west-2
 * /prod/<name>; local under /local/<name>. Auth uses the default
 * credential provider chain (ADC locally, task role in prod).
 *
 * Integration-specific secret shapes and loaders deliberately do NOT live
 * here — they belong to the integration that owns them.
 */

import { CreateSecretCommand, GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export const secretEnvCfg = (env: string): { region: string; prefix: string } => {
  if (env === "prod") return { region: "us-west-2", prefix: "/prod" };
  if (env === "local") return { region: "us-east-1", prefix: "/local" };
  return { region: "us-east-1", prefix: "/dev" };
};

/** Fetch and JSON-parse the secret named `<prefix>/<name>` for this env. */
export const fetchJson = async <T>(name: string, env: string): Promise<T> => {
  const { region, prefix } = secretEnvCfg(env);
  const client = new SecretsManagerClient({ region });
  const out = await client.send(new GetSecretValueCommand({ SecretId: `${prefix}/${name}` }));
  if (!out.SecretString) throw new Error(`Empty secret: ${prefix}/${name}`);
  return JSON.parse(out.SecretString) as T;
};

/** Create the secret `<prefix>/<name>` (fails if it already exists). */
export const createSecret = async (name: string, env: string, value: unknown): Promise<void> => {
  const { region, prefix } = secretEnvCfg(env);
  const client = new SecretsManagerClient({ region });
  await client.send(new CreateSecretCommand({ Name: `${prefix}/${name}`, SecretString: JSON.stringify(value) }));
};

// Thrown when a secret loads but is missing required keys. This is an
// operator misconfiguration of an existing secret — distinct from the
// secret being unavailable — so it is always fatal (see optionalSecretUnavailable).
export class SecretShapeError extends Error {}

/** Assert that `obj` has every key in `keys`, else throw SecretShapeError. */
export const required = <K extends string>(obj: Record<string, unknown>, keys: K[], name: string): void => {
  for (const k of keys) {
    if (!obj[k]) throw new SecretShapeError(`Secret ${name} missing key: ${k}`);
  }
};

/**
 * Decide how to handle a failure while loading an *optional* integration
 * secret. Backend-agnostic on purpose: we don't match AWS-specific error
 * names, because the secret store may be Secrets Manager, Vault, env
 * vars, etc. depending on the install.
 *
 * Rule:
 *   - A SecretShapeError (secret exists but is missing required keys) is
 *     a genuine misconfiguration → rethrow (fatal).
 *   - Any other failure — not found, access denied, store unreachable —
 *     means the integration simply isn't usable here. Disable it so the
 *     service still boots, but log a LOUD warning so the cause is visible
 *     instead of silently swallowed. Installers routinely forget to
 *     create the secret or grant read access; that should degrade one
 *     integration, not crash-loop the whole silo.
 *
 * Returns true if the caller should treat the secret as absent (null);
 * rethrows the SecretShapeError otherwise.
 */
export const optionalSecretUnavailable = (err: unknown, secretName: string): boolean => {
  if (err instanceof SecretShapeError) throw err;
  const reason = (err as { name?: string }).name ?? (err as Error).message ?? "unknown error";
  console.error(
    `[silo] WARNING: could not load optional secret "${secretName}" (${reason}). ` +
      `Treating this integration as DISABLED so the service can start. ` +
      `If you intend it to work, ensure the secret exists and the silo has ` +
      `read access to it, then restart.`
  );
  return true;
};
