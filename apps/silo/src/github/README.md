# GitHub integration (silo)

This package is silo's GitHub integration: inbound webhooks, the App
bootstrap (manifest) flow, workspace install (team) OAuth, per-user
identity binding, repo bindings, and outbound work-item sync. It plugs
into silo's integration registry (see `../integrations.ts` and
`../providers.ts`) and is loaded/mounted at startup like any other
provider.

## Per-environment apps

A GitHub App has exactly **one** webhook delivery URL (it's a single
field on the App). That URL is environment-specific
(`https://<host>/silo/api/github-webhook`), so **each environment needs
its own GitHub App** — one App cannot deliver webhooks to both local and
dev. We run three:

| env   | host                                    |
| ----- | --------------------------------------- |
| local | a developer's Tailscale Funnel hostname |
| dev   | `plane.dev.wildzebra.com`               |
| prod  | `plane.wildzebra.com`                   |

Each App's credentials (app id, slug, client id/secret, webhook secret,
private key) live in an AWS Secrets Manager secret at
`/<env>/plane-github`, written by the manifest flow (see below). OAuth
creds may live in a separate `/<env>/plane-github-oauth` secret. See
`secrets.ts`.

## The manifest is built in code, not shipped as a file

The GitHub App manifest is **derived at runtime from silo's own
config** — it is _not_ read from a JSON file. See `buildManifest` in
`oauth.ts`.

Every URL in the manifest is `${SILO_PUBLIC_BASE_URL}${SILO_BASE_PATH}/api/github/...`
and the rest (name, permissions, events) is static. Since silo already
knows its public base URL at runtime (`config.publicBaseUrl`, from
`SILO_PUBLIC_BASE_URL`), the per-env manifest is fully derivable from
that one value.

**Why in code rather than per-env JSON files:**

- **Generic container.** The silo image carries no environment-specific
  config. The only per-env input is `SILO_PUBLIC_BASE_URL`, injected at
  deploy time (for dev/prod this is set from the Plane hostname in
  corpinfra's `terraform/modules/plane`; locally it's the Tailscale
  Funnel URL). The same image runs in every environment.
- **No personal data in the image.** The old `github-app-manifest-local.json`
  hardcoded a developer's personal Tailscale hostname, which then shipped
  inside the prod/dev image.
- **It never actually worked in a container.** The files lived in
  `apps/silo/` and were read via `process.cwd()`. The runtime Docker
  stage (`Dockerfile.silo`) only copies `dist/`, `package.json`, and
  `node_modules/` — it never copied the manifest JSON — so in a deployed
  container the file was absent and the flow would `ENOENT`. It only
  worked locally because `pnpm dev` runs with cwd = `apps/silo`, where
  the file happened to sit. Building in code removes the file dependency
  entirely; no Dockerfile change is needed.

**Required config** (see `../config.ts`):

| env var                | config field           | example                           |
| ---------------------- | ---------------------- | --------------------------------- |
| `SILO_PUBLIC_BASE_URL` | `config.publicBaseUrl` | `https://plane.dev.wildzebra.com` |
| `SILO_BASE_PATH`       | `config.basePath`      | `/silo`                           |
| `SILO_ENV`             | `config.env`           | `dev`                             |

If `SILO_PUBLIC_BASE_URL` is wrong for the environment, the App is
created with the wrong webhook/callback URLs — verify it before running
the manifest flow.

## Routes

All paths are under `${SILO_BASE_PATH}` (default `/silo`). Registered in
`oauth.ts`, `user-oauth.ts`, `repos.ts`, and `webhook.ts`; mounted from
`index.ts`.

| Method | Path                                        | Purpose                                                                                                                                                                                               |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/github-webhook`                       | Inbound webhook delivery. HMAC-verified against the App's `webhook_secret` (`X-Hub-Signature-256`). Needs the **raw body** — excluded from the global JSON parser in `server.ts`; see `signature.ts`. |
| GET    | `/api/github/manifest?env=local\|dev\|prod` | Renders a self-posting form to GitHub's App-creation endpoint, using the in-code manifest.                                                                                                            |
| POST   | `/api/github/manifest/callback`             | Exchanges the manifest `code` for App credentials and writes `/<env>/plane-github`. **One-shot** — refuses if the secret already exists (`secrets.ts`).                                               |
| GET    | `/api/github/team/auth/url`                 | Returns the App's installation URL with a CSRF state.                                                                                                                                                 |
| GET    | `/api/github/team/auth/callback`            | Workspace install callback — validates state, fetches installation metadata, posts to Django.                                                                                                         |
| GET    | `/api/github/user/auth/url`                 | Returns the per-user OAuth authorize URL.                                                                                                                                                             |
| GET    | `/api/github/auth/user/callback`            | Per-user OAuth callback — binds a GitHub identity to a Plane user.                                                                                                                                    |

Note the manifest's `callback_urls` registers **both** the team
callback and the user callback. GitHub validates `redirect_uri` against
that list, so omitting the user callback makes per-user OAuth fail with a
redirect_uri mismatch.

### Bootstrap routes mount unconditionally

The two `manifest*` routes are **bootstrap** routes: they create the
`/<env>/plane-github` secret. Everything else (team/user OAuth, repos,
webhook) is gated on that secret existing — `mount()` in `index.ts`
early-returns when `isGithubConfigured()` is false. If the manifest
routes were behind the same gate, a fresh environment (no secret yet)
could never be set up: the only endpoint that creates the secret would
itself 404 until the secret existed. Chicken-and-egg.

So they live in a separate `githubBootstrapRouter()` wired through the
integration registry's `bootstrap()` hook (`integrations.ts`
`bootstrapIntegrations`), which runs for every integration regardless of
whether `load()` succeeded. `githubOAuthRouter()` and friends stay behind
`mount()`. When deleting `/<env>/plane-github` to re-bootstrap, this is
what keeps the manifest endpoint reachable.

## Bootstrapping an environment (fresh App)

1. Ensure the env's silo is running the current build with the correct
   `SILO_PUBLIC_BASE_URL`.
2. If a stale/orphan secret exists at `/<env>/plane-github`, delete it
   first — the manifest callback is one-shot and refuses to overwrite an
   existing secret.
3. Visit `https://<host>/silo/api/github/manifest?env=<env>` and submit
   the form. GitHub creates the App and redirects back; silo stores the
   credentials in `/<env>/plane-github`.
4. On the new App's page, click **Install App** to install it into the
   org and select repositories.
5. Connect from the Plane workspace (team install + per-user OAuth).

## GitHub Enterprise Server (GHES)

The flow supports pointing at a self-hosted GHES instead of
github.com. The GHES origin rides through GitHub's redirect in the
manifest `state` (`encodeManifestState`/`decodeManifestState` in
`oauth.ts`) and is validated against an operator allowlist
(`GITHUB_GHES_ALLOWED_HOSTS`) before any server-side call carries App
credentials to it. See `host.ts` for the URL switching and the SSRF
guard rationale.
