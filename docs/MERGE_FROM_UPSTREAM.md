# Merging changes from upstream Plane (makeplane/plane)

Runbook for pulling recent changes from upstream Plane CE into our
`zebaria/plane` fork's `preview` branch, without re-introducing the
mistakes that bit us before.

## Ground rules (read first)

- **Upstream (`makeplane/plane`) is READ ONLY. We never push to it,
  never open a PR/issue/comment on it, never write to it in any way.**
  The only thing we do with upstream is fetch in step 2. Every push in
  this runbook goes to `origin` (`zebaria/plane`) and nowhere else.
- **The `upstream` remote is temporary.** Add it only for the fetch in
  step 2 (with its push URL disabled) and **remove it immediately**
  after. A lingering upstream remote is how our changes got pushed to
  `makeplane/plane` by mistake.
- **`origin` is `git@github.com:zebaria/plane.git` and is the only
  remote outside step 2.** Confirm with `git remote -v` before and
  after — it must stay that way.
- **Never merge straight onto `preview`.** Do the merge on a throwaway
  sync branch, verify, then fast-forward/merge into `preview` yourself.
- Our integration code (`apps/silo/`, `apps/api/plane/connections/`,
  `apps/api/plane/bgtasks/silo_notification_task.py`) is additive and
  upstream doesn't touch it — but our web UI and a few API views DO sit
  in upstream-owned files. See "Where we touch upstream code".
- **Merge in passes when upstream made breaking changes.** If the
  incoming range contains a package swap or a big directory move,
  merge up to the commit just before it, then through it, then the
  rest — one merge commit per pass, so each pass has one kind of
  conflict. See step 4.

## Prerequisites

- Clean working tree on `preview` (`git status` empty). Commit/stash
  fork work first.
- `pnpm` + Node toolchain available (lockfile regeneration).
- `uv` available. The API's deps live in `apps/api/pyproject.toml` +
  `uv.lock`, and `pyproject.toml` pins an exact uv version
  (`[tool.uv] required-version`). Run that exact version via `uvx`
  rather than whatever uv is installed:
  `uvx uv@<required-version> lock`.

## Steps

### 1. Confirm starting state

```bash
cd ~/proj/zebaria/plane
git switch preview
git status --short          # must be empty
git remote -v               # must show ONLY origin → zebaria/plane
```

### 2. Temporary upstream remote: add, fetch, remove

Add the remote, disable pushes to it, fetch, and remove it right away —
nothing else happens while it exists:

```bash
git remote add upstream https://github.com/makeplane/plane.git
git remote set-url --push upstream DISABLED   # any push to it fails
git fetch --no-tags upstream preview          # sets FETCH_HEAD
git remote remove upstream                    # immediately
git remote -v               # re-confirm: ONLY origin
```

The rest of the runbook uses `FETCH_HEAD`, so the remote isn't needed
after the fetch.

### 3. See what's incoming before merging

Large syncs exceed git's default rename limit, which silently disables
rename detection (moved directories then show up as delete + add).
Pass `-c merge.renameLimit=5000` to every diff/merge in steps 3–4.

```bash
# How many commits each way
git rev-list --count HEAD..FETCH_HEAD     # upstream commits we'd pull
git rev-list --count FETCH_HEAD..HEAD     # our fork commits upstream lacks

# The incoming commits
git log --oneline HEAD..FETCH_HEAD

# Trial merge: the actual conflict list, without touching the tree
git -c merge.renameLimit=5000 merge-tree --write-tree HEAD FETCH_HEAD \
  | grep '^CONFLICT'

# Did upstream touch the places we customize? (see "Where we touch
# upstream code" for the full list)
git diff --name-only HEAD...FETCH_HEAD | grep -iE \
  'connections|silo|issue_activities_task|settings/common|plane/urls.py|utils/constants|views/asset.py|views/issue.py|issue/attachment.py|integration|settings/(profile|project|workspace)/sidebar|caddy/Caddyfile|admin/app/.*/workspace/page|pyproject.toml|uv.lock|requirements'
```

If upstream touched `plane/connections/`, `silo_notification_task.py`,
or `apps/silo/` directly, slow down — that's unusual and means a real
overlap with our code. Normally it touches none of these.

**Look for breaking changes** in the incoming log — package swaps
(e.g. `@plane/ui` → `@makeplane/propel`), directory moves (e.g. the
`apps/web/core/` flatten), dependency-tool changes (e.g.
`requirements/*.txt` → `uv`). If there are any, plan passes (step 4).
A breaking import change merges _clean_ in our files and only fails at
type-check, so the conflict list alone won't show it.

**Review every incoming workflow change** before merging (see
`SECURITY-zebaria.md`): a malicious upstream commit could add a workflow
that exfiltrates secrets, and changed triggers start running on our
pushes.

```bash
git diff --name-only HEAD...FETCH_HEAD -- .github/
git diff HEAD...FETCH_HEAD -- .github/workflows/ | grep -E \
  '^\+.*(secrets\.|pull_request_target|workflow_run|curl|wget|permissions|on:|branches)'
```

Also note new CI gates that our flow must satisfy (e.g. `check-version`
now also requires `apps/api/pyproject.toml`'s version to equal
`package.json`'s).

### 4. Merge on a sync branch (never directly on preview)

```bash
git switch -c sync-upstream-preview
git -c merge.renameLimit=5000 merge --no-ff --no-commit FETCH_HEAD
```

`--no-commit` lets you inspect/resolve before anything is recorded.

**In passes:** merge an upstream commit SHA instead of `FETCH_HEAD`,
then run steps 5–6 and commit, and repeat for the next pass. Typical
split around a breaking change at commit `X`:

1. `git merge ... X^` — everything before it.
2. `git merge ... <last commit of the breaking change>` — the change
   itself; port our code to it here.
3. `git merge ... FETCH_HEAD` — the rest.

All passes stay on `sync-upstream-preview` and go to `preview`
together in step 7. If a pass goes wrong, reset to the previous pass's
commit instead of redoing the whole sync.

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

- **Versions** — keep our version line in `package.json` unless you're
  deliberately moving to upstream's. `apps/api/pyproject.toml`'s
  `version` must equal `package.json`'s (CI `check-version`); set it,
  then regenerate `uv.lock`:

  ```bash
  (cd apps/api && uvx uv@<required-version> lock)
  ```

- **API dependencies** — they're in `apps/api/pyproject.toml` (our
  PyCharm `pydevd-pycharm` pin is in the `dev` group). Resolve there,
  never in a `requirements/*.txt`; upstream deleted those.

- **Our files under a moved directory** — git reports
  `CONFLICT (file location)` and usually puts them at the new path.
  Check each one landed where upstream's equivalents now live, and that
  nothing of ours is left under the old path.

- **Removed upstream components/packages** — our code that imports
  them merges cleanly and then fails the type-check. Port it to
  whatever upstream's own code uses now (grep how upstream converted
  the same component, e.g. `ModalCore` → `Dialog`,
  `ToggleSwitch` → `Switch`, lucide icons → `@makeplane/propel/icons`).

Stage each resolved file **by name** — never `git add -A` / `git add .`:

```bash
git status --short                     # see exactly what's unmerged/changed
git add -- <each resolved file>
git diff --name-only --diff-filter=U   # must print nothing
git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!*.md'   # must print nothing
```

### 6. Verify before committing

```bash
# Lockfile consistent with merged manifests
pnpm install --frozen-lockfile --lockfile-only   # exit 0

# Our code intact
ls apps/api/plane/connections/ apps/api/plane/bgtasks/silo_notification_task.py

# Install, then type-check EVERY app — not just web. A web-only check
# missed a broken god-mode (admin) page last time.
pnpm install --frozen-lockfile
pnpm turbo run check:types              # all tasks must pass

# Web and silo tests
pnpm --filter web test
pnpm --filter silo build
pnpm --filter silo test

# API: rebuild the venv from uv.lock, then Django checks
(cd apps/api && uvx uv@<required-version> sync --locked --python 3.12)
(cd apps/api && set -a && . ./.env && set +a && \
  .venv/bin/python manage.py check && \
  .venv/bin/python manage.py makemigrations --check --dry-run)

# API lint, the same way CI's "Lint API" runs it (no --fix)
(cd apps/api && uvx uv@<required-version> run --no-sync ruff check .)

# Upstream's asset/attachment tests (our attachment toggle hooks in
# there). --create-db: --reuse-db keeps a stale schema across syncs.
(cd apps/api && set -a && . ./.env && set +a && \
  .venv/bin/python -m pytest plane/tests/contract -k "asset or attachment" \
  -q -p no:cacheprovider --create-db)
```

Then, after the merge is on dev (step 7), check the things that only
show up in a browser:

- **A full cold page load** of web and god-mode. Upstream's
  `apps/{web,admin}/caddy/Caddyfile` rate-limits static assets per IP;
  at their 300/min a code-split build 429'd mid-load and the app sat
  on its progress bar. Ours is 3000/min — make sure a merge didn't
  reset it.
- Settings pages (profile / project / workspace sidebars).
- Integrations: Slack + GitHub cards, and a real Slack/GitHub
  round-trip through silo (the silo→Django HMAC ping). For Slack,
  create a work item in a project with a channel mapping and confirm
  the message lands. If it doesn't, the silo log shows each step
  (`notifications event_type=…`, `dispatch channel mappings=N`); silo
  only logs a post when it _fails_, so silence after `mappings=N`
  usually means the message went to a different mapped channel or no
  mapping subscribes to that event — check the project's
  Notifications settings before suspecting the merge.
- Work item attachments: a non-image file (e.g. `.txt`) through the
  paperclip, and the god-mode "Allow all attachment file types"
  toggle — with it on, a non-allowlisted type uploads; with it off,
  the API returns 400 "Invalid file type". The paperclip is the only
  any-type upload; comment/description editor uploads are images only
  by design.

### 7. Commit the merge, then bring it into preview

```bash
# --no-verify is expected here: lint-staged would run oxlint + oxfmt
# over every merged upstream file (~1,000+), oxfmt gets SIGKILLed, and
# reformatting upstream's code would only add churn. Instead, format
# and lint just the files YOU edited before committing:
#   pnpm exec oxfmt <files you edited>
#   pnpm exec oxlint <files you edited>
# Say in the commit message why --no-verify was used.
git commit --no-verify   # records the merge on sync-upstream-preview

git switch preview
git merge --ff-only sync-upstream-preview
git push origin preview
git branch -d sync-upstream-preview
```

Upstream merges are the one case that does NOT go through `ship`.
`ship` squash-merges by design, and a squash drops the link to
upstream's commits — the next sync would then re-merge everything and
hit the same conflicts again. The merge commit must land on `preview`
as-is, so fast-forward `preview` and push it to `origin` by hand.

## Where we touch upstream code

Entirely ours (upstream never edits these):

- `apps/silo/` — upstream has no `apps/silo`.
- `apps/api/plane/connections/` — our Django app. One-way FKs into
  upstream models (Workspace/Project/Issue/User); nothing upstream FKs
  into ours.

Our edits inside upstream-owned files (this is where conflicts and
silent breakage come from):

- **API registration:** `settings/common.py` (3 lines), `plane/urls.py`
  (1 mount), `plane/bgtasks/issue_activities_task.py` (1 dispatch
  block), `plane/utils/constants.py` (1 allowlist entry).
- **Attachment toggle:** `plane/utils/attachment.py` (ours), called
  from `api/views/asset.py`, `api/views/issue.py`,
  `app/views/issue/attachment.py`; the god-mode switch in
  `apps/admin/app/(all)/(dashboard)/workspace/page.tsx`.
- **Web integration UI:** `apps/web/components/integration/`
  (`silo-*-card.tsx`, `ghes-host.ts`, `github-repo-bindings/`,
  `slack-notifications/`), `components/settings/profile/content/pages/
connections.tsx`, `services/integrations/silo.service.ts`, the
  workspace integrations `page.tsx`, the project notifications page
  and header, and our extra tabs in the profile / project / workspace
  settings sidebars.
- **Web tests:** `apps/web/vitest.config.ts` (aliases must follow
  upstream's `tsconfig.json` paths) and `apps/web/tests/`.
- **Static serving:** `apps/{web,admin}/caddy/Caddyfile` rate limit.
- **Upload type fallback:** `packages/services/src/file/helper.ts`
  sends the browser's MIME type when magic-byte detection finds
  nothing (text files).
- **Build/dev:** `.husky/pre-commit` (version bump + pyproject sync),
  `zstart` (`uv sync`), `.github/workflows/zebaria-*.yml`.

Most of our API work merges cleanly. Expect conflicts in dependency
manifests, version fields, and — when upstream redesigns the UI — the
web files above. If you see a conflict deep in `plane/connections/` or
`apps/silo/` originating from upstream, upstream added something
overlapping — investigate rather than blindly resolving.

## What NOT to do

- ❌ **Push, open a PR, or write anything to `makeplane/plane`.**
  Upstream is read-only. If a command would target it, stop.
- ❌ Leave the `upstream` remote in place after the fetch. Remove it
  immediately.
- ❌ Merge FETCH_HEAD directly onto `preview`.
- ❌ Hand-edit `pnpm-lock.yaml` or `uv.lock` conflict hunks —
  regenerate instead.
- ❌ `git add -A` / `git add .` — stage resolved files by name.
- ❌ Type-check only `web` — run `pnpm turbo run check:types` for every
  app.
- ❌ Skip the workflow review in step 3.
- ❌ Resolve a `package.json` catalog conflict by dropping our explicit
  test deps — keep both sides.
- ❌ Send an upstream merge through `ship` — it squashes and loses
  the upstream ancestry. Fast-forward and push `preview` (step 7).
