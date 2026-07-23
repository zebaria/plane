# Releasing and deploying Plane (zebaria fork)

_Last updated: 2026-07-23._

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

- Feature work: PR into `preview`. Infra/upstream-merge work can push
  `preview` directly (see `MERGE_FROM_UPSTREAM.md`).
- `promote` opens a `preview → master` PR.
- `promote --merge <N>` merges it and resets `preview` onto master.
- Always pass `--repo zebaria/plane` on `gh` commands — the fork has
  makeplane upstream in its history, so bare `gh` can target the wrong
  repo.

## The version bump (check-version gate)

CI `check-version` **fails any promote PR whose `package.json` version
equals master's**, and `promote` does not bump automatically. This is
handled by `.husky/pre-commit`: on the `preview` branch, if the version
still equals `origin/master`'s, it patch-bumps `package.json` and stages
it — so the first commit of each promote cycle bumps once, later commits
skip. **If that hook is bypassed (`--no-verify`) or removed, bump
`package.json` manually before `promote`** or the promote PR goes red.

## CI: build + deploy (`.github/workflows/zebaria-build.yml`)

Triggers on push to `preview`, `main`, or `master`, on `v*` tags, and
manual dispatch. Builds the 6 images and pushes to ECR in us-east-1 (dev)
and us-west-2 (prod), tagged with the branch/tag name.

- **`deploy-dev`** — auto-rolls the dev host on a `preview` push
  (`:preview` image). Pull + restart only; host config files
  (docker-compose.yml, render-env.sh, ecr-login.sh) are owned by
  `deploy-config.sh` and are NOT touched.
- **`deploy-prod`** — same mechanics, gated on `master`, us-west-2.

## ⚠️ Prod auto-deploy is NOT reliable yet

Two known problems with `deploy-prod`:

1. **Racy trigger.** `promote --merge` pushes the merge commit to
   `master` and resets `preview` to the same SHA near-simultaneously.
   GitHub often dedupes the workflow run onto the `preview` ref, so no
   `master`-ref run fires and `deploy-prod` (`if: github.ref ==
'refs/heads/master'`) never runs. It fired for one promote and not
   the next.
2. **Tag mismatch.** The prod host pulls the **`:preview`** image
   (`plane_image_tag` module default = `preview`; prod doesn't override),
   but `deploy-prod` is oriented around `:master`.

**To fix properly (TODO):** decouple `deploy-prod` from the branch-push
event (trigger off a successful `:master` build via `needs`/`workflow_run`,
not `github.ref`), and align the tag the prod host pulls with what the
pipeline builds.

## Deploying prod manually (current reliable path)

Safe — pull + restart only, no config rewrite. Works because `:preview`
is rebuilt on every promote and prod pulls `:preview`.

```bash
PID=$(aws ec2 describe-instances --region us-west-2 \
  --filters "Name=tag:Module,Values=plane" \
            "Name=tag:Environment,Values=prod" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)

aws ssm send-command --region us-west-2 --instance-ids "$PID" \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":[
    "/opt/plane/ecr-login.sh",
    "docker compose -f /opt/plane/docker-compose.yml pull",
    "systemctl restart plane.service",
    "systemctl is-active plane.service",
    "docker compose -f /opt/plane/docker-compose.yml ps"
  ]}'
```

(Or, from corpinfra, `terraform/modules/plane/scripts/deploy-config.sh
prod` — that ALSO rewrites host config from the module, use it when
compose/env changed, not just for a new image.)

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
