# Releasing and deploying Plane (zebaria fork)

_Last updated: 2026-11-11._

How code gets from a feature branch to `plane.wildzebra.com`. Read
alongside `MERGE_FROM_UPSTREAM.md` (pulling upstream) and
`corpinfra/terraform/modules/plane/` (the hosts + deploy-config.sh).

## Branches and the release flow

Release tooling is **vibegrunt** (`.vibegrunt.toml`), driven by the
`promote` CLI — NOT corpinfra's `ship`. Config: `dev = preview`,
`main = master`, version file = `package.json`.

```
feature branch ─PR→ preview ─promote→ master
```

- Changes reach `preview` through `ship`. The one exception is
  upstream merges: `ship` squash-merges by design, which would drop
  upstream's ancestry, so those are fast-forwarded and pushed to
  `preview` by hand (see `MERGE_FROM_UPSTREAM.md` step 7).
- `promote` opens a `preview → master` PR.
- `promote --merge <N>` merges it and resets `preview` onto master.
- Always pass `--repo zebaria/plane` on `gh` commands — the fork has
  makeplane upstream in its history, so bare `gh` can target the wrong
  repo.

## The version bump (check-version gate)

CI `check-version` **fails any promote PR whose `package.json` version
equals master's, or whose `apps/api/pyproject.toml` version differs from
`package.json`'s**. `promote` does not bump automatically; `ship` bumps
the patch on every feature PR. `.husky/pre-commit` keeps both rules
satisfied:

- On the `preview` branch, if the version still equals
  `origin/master`'s, it patch-bumps `package.json` and stages it — so
  the first commit of each promote cycle bumps once.
- On any branch, whenever a `package.json` version is staged, it copies
  that version into `apps/api/pyproject.toml` and refreshes
  `apps/api/uv.lock`.

**If that hook is bypassed (`--no-verify`) or removed, bump both files
by hand (and run `uvx uv@<required-version> lock` in `apps/api`) before
`promote`** or the promote PR goes red.

## CI: build + deploy (`.github/workflows/zebaria-build.yml`)

Triggers on push to `preview`, `main`, or `master`, and on manual
dispatch (not on tags — `ship --merge` pushes a `v*` tag, which used to
start a redundant second build). Builds the 7 images (admin, frontend,
space, live, proxy, backend, silo) and pushes them to ECR in us-east-1
(dev) and us-west-2 (prod), tagged with the branch name.

- **`deploy-dev`** — on a `preview` push, rolls the dev host
  (us-east-1). Pull + restart only.
- **`deploy-prod`** — on a `master` push (i.e. `promote --merge`), rolls
  the prod host (us-west-2) the same way.

Both jobs find the host by tag, then SSM `AWS-RunShellScript`:
`ecr-login.sh`, `docker compose pull`, `systemctl restart plane.service`,
`docker image prune -af`. Host config files (docker-compose.yml,
render-env.sh, ecr-login.sh) are owned by corpinfra's
`deploy-config.sh` and are NOT touched by CI.

**IAM roles** (corpinfra `terraform/modules/plane_dev/oidc.tf`):

- `gh-actions-zebaria-plane` — build + `deploy-dev`. Trusts every ref
  in this repo, so it has **no prod access** (SSM in us-east-1 only).
- `gh-actions-zebaria-plane-prod-deploy` — `deploy-prod` only. Trust is
  pinned to `refs/heads/master`, so no other branch, tag, or PR
  workflow can run commands on prod.

**Image tag:** both hosts pull **`:preview`** (`plane_image_tag` module
default; prod doesn't override). That's correct for prod because
`promote --merge` leaves `preview` and `master` on the same commit, so
`:preview` and `:master` are built from identical code.

**We do not deploy by hand.** Prod is deployed only by `promote --merge`
→ `deploy-prod`. If `deploy-prod` fails, read its log, fix the cause
(workflow or IAM), and re-run the failed job from the Actions tab. When
a change needs new host config (compose/env), that goes through
corpinfra (`deploy-config.sh`), not an ad-hoc command on the host.

## PR review notes

- Reviewers **Kody** and **Gemini** run on PRs. They frequently time out
  (never post) and have produced low-quality feedback — evaluate each
  comment against the code, don't apply on faith.
- **CodeQL** compares against `master`. Promoting code that's new to
  master (e.g. the whole `apps/silo` integration on its first promote)
  surfaces all of it as "new alerts". Triage and dismiss via
  `gh api repos/zebaria/plane/code-scanning/alerts/<N> -f state=dismissed
-f dismissed_reason=... -f dismissed_comment=...` (comment ≤ 280 chars).
  Known dispositions for silo: SSRF in `github/api.ts` = false positive
  (`validateGhesOrigin` allowlist), Slack/notification type-confusion +
  missing-rate-limiting = won't-fix (HMAC-gated).
