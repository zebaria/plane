# CLAUDE.md

Repository-specific guidance for Claude Code working in `zebaria/plane`.

## Hard rules — read first

### NEVER push or open a PR to `makeplane/plane` (upstream)

This is a **fork**. Origin (`zebaria/plane`) is where our changes live.
**Upstream (`makeplane/plane`) is READ ONLY. Nothing we write ever goes
to it** — no `git push`, no PR, no issue, no comment, no branch, no tag.
The only operation ever performed against upstream is a fetch while
pulling upstream changes (see `docs/MERGE_FROM_UPSTREAM.md`).

- The `upstream` remote exists **only temporarily during a pull**: add
  it, disable its push URL, fetch, and **remove it immediately** after
  the fetch. It was made temporary after our changes were pushed to
  makeplane/plane by mistake. Outside that window `git remote` must only
  print `origin`; if `upstream` is still there, remove it.
- Never put a makeplane URL in a `git push`, `gh` command, or API call.
  If any command would write to `makeplane/plane`, stop — don't run it.
- `gh` can still target upstream by default because GitHub treats the
  fork's parent as the default base repo for PRs.

**Always pass `--repo zebaria/plane` (and `--base preview`) when
creating PRs.** The `ship` wrapper sometimes infers the wrong target
on first run — verify with `gh pr view <NUMBER>` after creating, and
close + recreate immediately if `base.repo.full_name` is `makeplane/plane`.

A PR opened against upstream is a serious mistake: it leaks our
in-flight changes (and any sensitive context in commit messages /
PR descriptions) to a public open-source project we don't control.

### Other repo conventions

- Default branch: `preview` (not `main` or `master`).
- Production branch: `master`.
- Branch naming: `WZ-<id>-<slug>` (`ship` script generates these).
- The `.vibegrunt.toml` config (gitignored) overrides defaults —
  `branches.dev = "preview"`, `branches.main = "master"`,
  `version.file = "package.json"`.
