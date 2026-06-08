# Merging changes from upstream Plane (makeplane/plane)

Runbook for pulling recent changes from upstream Plane CE into our
`zebaria/plane` fork's `preview` branch, without re-introducing the
mistakes that bit us before.

## Ground rules (read first)

- **Do NOT add a permanent `upstream` remote.** We deliberately removed
  it. A persistent remote led to PRs being opened against
  `makeplane/plane` by mistake. Always fetch upstream by **one-off
  URL**, which writes nothing to `.git/config`.
- **`origin` is `git@github.com:zebaria/plane.git` and is the only
  remote.** Confirm with `git remote -v` before and after — it must
  stay that way.
- **Never merge straight onto `preview`.** Do the merge on a throwaway
  sync branch, verify, then fast-forward/merge into `preview` yourself.
- Our integration code (`apps/silo/`, `apps/api/plane/connections/`,
  `apps/api/plane/bgtasks/silo_notification_task.py`) is additive and
  upstream doesn't touch it — see "Why this is usually low-conflict".

## Prerequisites

- Clean working tree on `preview` (`git status` empty). Commit/stash
  fork work first.
- `pnpm` + Node toolchain available (lockfile regeneration).

## Steps

### 1. Confirm starting state

```bash
cd ~/proj/zebaria/plane
git switch preview
git status --short          # must be empty
git remote -v               # must show ONLY origin → zebaria/plane
```

### 2. Ephemeral fetch from upstream

No remote added — fetch by URL into `FETCH_HEAD`:

```bash
git fetch --no-tags https://github.com/makeplane/plane.git preview
git remote -v               # re-confirm: still ONLY origin
```

### 3. See what's incoming before merging

```bash
# How many commits each way
git rev-list --count HEAD..FETCH_HEAD     # upstream commits we'd pull
git rev-list --count FETCH_HEAD..HEAD     # our fork commits upstream lacks

# The incoming commits
git log --oneline HEAD..FETCH_HEAD

# Files we BOTH changed (the real conflict set)
comm -12 \
  <(git diff --name-only HEAD...FETCH_HEAD | sort -u) \
  <(git diff --name-only FETCH_HEAD...HEAD | sort -u)

# Did upstream touch our coupling points?
git diff --name-only HEAD...FETCH_HEAD | grep -iE \
  'connections|silo|issue_activities_task|settings/common|plane/urls.py|utils/constants'
```

If upstream touched `plane/connections/`, `silo_notification_task.py`,
or `apps/silo/` directly, slow down — that's unusual and means a real
overlap with our code. Normally it touches none of these.

### 4. Merge on a sync branch (never directly on preview)

```bash
git switch -c sync-upstream-preview
git merge --no-ff --no-commit FETCH_HEAD
```

`--no-commit` lets you inspect/resolve before anything is recorded.

### 5. Resolve conflicts

Expected conflict set (from experience): **dependency manifests +
`settings/common.py`**. Our additive Django/silo code merges clean.

- **`apps/api/plane/settings/common.py`** — usually auto-merges. Always
  verify our additions survived:

  ```bash
  grep -nE 'SILO_HMAC_SECRET_KEY|plane.connections|silo_notification' \
    apps/api/plane/settings/common.py
  ```

  Expect: `SILO_HMAC_SECRET_KEY` setting, `"plane.connections"` in
  INSTALLED_APPS, `"plane.bgtasks.silo_notification_task"` in the
  Celery beat schedule.

- **`apps/web/package.json` / root `package.json`** — conflicts here are
  usually upstream migrating deps to the **pnpm catalog** (`"catalog:"`)
  vs. our explicit-version additions (e.g. the `vitest` /
  `@testing-library/*` / `jsdom` test stack). Resolution: **keep both**
  — take upstream's `catalog:` entries AND keep our explicit deps that
  aren't in the catalog.

- **`pnpm-lock.yaml`** — do NOT hand-merge. Take one side as a base then
  regenerate from the merged manifests:
  ```bash
  git checkout --theirs pnpm-lock.yaml
  pnpm install --lockfile-only
  ```

Stage resolutions:

```bash
git add apps/web/package.json package.json pnpm-lock.yaml
git diff --name-only --diff-filter=U   # must print nothing
```

### 6. Verify before committing

```bash
# Lockfile consistent with merged manifests
pnpm install --frozen-lockfile --lockfile-only   # exit 0

# Our code intact
ls apps/api/plane/connections/ apps/api/plane/bgtasks/silo_notification_task.py

# Run the silo test suite (upstream often bumps test/build deps)
pnpm --filter silo build
pnpm --filter silo test
```

Smoke-test anything upstream hardened that touches our flows (recent
example: API rate-limit + SSRF changes — confirm the silo→Django HMAC
ping and a Slack/GitHub round-trip still work if those areas changed).

### 7. Commit the merge, then bring it into preview

```bash
git commit            # records the merge on sync-upstream-preview

git switch preview
git merge --ff-only sync-upstream-preview   # or review-merge
git branch -d sync-upstream-preview
```

Push `preview` only through the normal flow (`ship`), not a bare
`git push` — see the repo's no-direct-push convention.

## Why this is usually low-conflict

Our work is a cleanly isolated app, not edits sprayed across upstream:

- `apps/silo/` — entirely ours; upstream has no `apps/silo`.
- `apps/api/plane/connections/` — our Django app; upstream doesn't edit
  it. One-way FKs into upstream models (Workspace/Project/Issue/User);
  nothing upstream FKs into ours.
- The only edits to upstream-owned Django files are ~registration-tier:
  `settings/common.py` (3 lines), `plane/urls.py` (1 mount),
  `plane/bgtasks/issue_activities_task.py` (1 dispatch block),
  `plane/utils/constants.py` (1 allowlist entry).

So conflicts cluster in shared infra files (dependency manifests,
settings) rather than business logic. If you ever see a conflict deep
in `plane/connections/` or `apps/silo/` originating from upstream,
that's a signal upstream added something overlapping — investigate
rather than blindly resolving.

## What NOT to do

- ❌ `git remote add upstream ...` (permanent remote → accidental
  upstream PRs).
- ❌ Merge FETCH_HEAD directly onto `preview`.
- ❌ Hand-edit `pnpm-lock.yaml` conflict hunks — regenerate instead.
- ❌ Resolve a `package.json` catalog conflict by dropping our explicit
  test deps — keep both sides.
- ❌ `git push` to `preview` directly — use `ship`.
