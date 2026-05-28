/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Pulls provider secrets from AWS Secrets Manager at startup. Per
 * the corpinfra convention: dev secrets live in us-east-1 under
 * /dev/<name>; prod under us-west-2 /prod/<name>. Auth uses default
 * credential provider chain (ADC locally, task role in prod).
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type SlackSecrets = {
  client_id: string;
  client_secret: string;
  signing_secret: string;
};

const envCfg = (env: string): { region: string; prefix: string } => {
  if (env === "prod") return { region: "us-west-2", prefix: "/prod" };
  return { region: "us-east-1", prefix: "/dev" };
};

const fetchJson = async <T>(name: string, env: string): Promise<T> => {
  const { region, prefix } = envCfg(env);
  const client = new SecretsManagerClient({ region });
  const out = await client.send(new GetSecretValueCommand({ SecretId: `${prefix}/${name}` }));
  if (!out.SecretString) throw new Error(`Empty secret: ${prefix}/${name}`);
  return JSON.parse(out.SecretString) as T;
};

const required = <K extends string>(obj: Record<string, unknown>, keys: K[], name: string): void => {
  for (const k of keys) {
    if (!obj[k]) throw new Error(`Secret ${name} missing key: ${k}`);
  }
};

export const loadSlackSecrets = async (env: string): Promise<SlackSecrets> => {
  // Local-dev fallback: if all three Slack env vars are present, skip
  // Secrets Manager entirely. Avoids the dev-loop crashing when the
  // workstation has no AWS creds for the silo IAM role's namespace.
  const envClientId = process.env.SLACK_CLIENT_ID;
  const envClientSecret = process.env.SLACK_CLIENT_SECRET;
  const envSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (envClientId && envClientSecret && envSigningSecret) {
    return {
      client_id: envClientId,
      client_secret: envClientSecret,
      signing_secret: envSigningSecret,
    };
  }
  const v = await fetchJson<SlackSecrets>("plane-slack", env);
  required(v as unknown as Record<string, unknown>, ["client_id", "client_secret", "signing_secret"], "plane-slack");
  return v;
};
