# Copyright (c) 2026-present Zebaria.
# SPDX-License-Identifier: AGPL-3.0-only
"""Contract tests for the Django endpoints that back the GH outbound
mirror.

Covers the additions made for Phase 4e:
  - SiloGithubRepoBindingsEndpoint accepts (workspace_slug, project_id)
    in addition to the existing (installation_id, repo_id) inbound mode.
  - SiloGithubIssueLinkLookupEndpoint accepts plane_issue_id (in
    addition to gh_issue_id) so outbound can short-circuit duplicate
    creates.
  - SiloGithubIssueLinkEndpoint merges plane_comment_map into
    entity_data alongside the existing gh_comment_map.
  - SiloCreateWorkItemEndpoint accepts description_html as a
    pass-through field (used by the GH inbound's marked-rendered
    HTML), keeping the legacy plain-text `description` path
    HTML-escaping for Slack action submits.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest
from django.core.cache import cache
from django.utils import timezone

from plane.connections.models import (
    WorkspaceConnection,
    WorkspaceCredential,
    WorkspaceEntityConnection,
)
from plane.db.models import (
    Issue,
    IssueComment,
    Project,
    ProjectMember,
    State,
    Workspace,
    WorkspaceMember,
)


SECRET = "contract-test-silo-secret"


@pytest.fixture(autouse=True)
def _reset_throttle_cache():
    # Silo endpoints inherit the global AnonRateThrottle (30/min), and
    # its counter lives in the Redis cache, which persists across tests
    # AND across pytest runs. Without clearing it, a module with >30
    # requests/min starts 429-ing partway through (and stays poisoned on
    # the next run). Clear before each test so throttling can't bleed in.
    cache.clear()
    yield


def _sign(method: str, path: str, body: bytes) -> dict:
    ts = str(int(time.time()))
    body_hash = hashlib.sha256(body or b"").hexdigest()
    msg = f"{ts}.{method.upper()}.{path}.{body_hash}".encode()
    sig = hmac.new(SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return {"HTTP_X_SILO_TIMESTAMP": ts, "HTTP_X_SILO_SIGNATURE": sig}


def _post_silo(api_client, settings, path: str, body: dict):
    settings.SILO_HMAC_SECRET_KEY = SECRET
    raw = json.dumps(body).encode()
    return api_client.post(
        path,
        data=raw,
        content_type="application/json",
        **_sign("POST", path, raw),
    )


@pytest.fixture
def project(db, create_user, workspace):
    p = Project.objects.create(name="Test", identifier="TST", workspace=workspace)
    ProjectMember.objects.create(project=p, member=create_user)
    return p


@pytest.fixture
def github_credential(db, project, create_user):
    return WorkspaceCredential.objects.create(
        workspace=project.workspace,
        user=create_user,
        source="github",
        source_identifier="42",
        source_access_token="ghs_fake",
        is_pat=False,
        is_active=True,
    )


@pytest.fixture
def github_workspace_connection(db, project, github_credential):
    return WorkspaceConnection.objects.create(
        workspace=project.workspace,
        credential=github_credential,
        connection_type="github",
        connection_id="42",
        connection_slug="zebaria",
    )


@pytest.fixture
def repo_binding(db, project, github_workspace_connection):
    return WorkspaceEntityConnection.objects.create(
        workspace=project.workspace,
        workspace_connection=github_workspace_connection,
        project=project,
        type="github-repo",
        entity_type="repository",
        entity_id="999",
        entity_slug="zebaria/plane",
        config={"direction": "bi", "issueStateMap": {"open": "S_O", "closed": "S_C"}},
    )


@pytest.mark.contract
class TestRepoBindingsOutboundLookup:
    """Phase 4e: lookup by (workspace_slug, project_id) — outbound starts
    installation_id."""

    PATH = "/api/v1/silo/github/repo-bindings/"

    def test_outbound_lookup_returns_binding(self, db, api_client, settings, project, repo_binding):
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": str(project.id)},
        )
        assert r.status_code == 200, r.content
        bindings = r.json()["bindings"]
        assert len(bindings) == 1
        assert bindings[0]["entity_slug"] == "zebaria/plane"
        # Outbound dispatcher needs installation_id to call GH.
        assert bindings[0]["installation_id"] == "42"

    def test_inbound_lookup_still_works(self, db, api_client, settings, repo_binding):
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"installation_id": "42", "repo_id": "999"},
        )
        assert r.status_code == 200
        assert len(r.json()["bindings"]) == 1

    def test_neither_mode_supplied_400(self, db, api_client, settings):
        r = _post_silo(api_client, settings, self.PATH, {})
        assert r.status_code == 400

    def test_outbound_without_project_returns_empty(self, db, api_client, settings, project, repo_binding):
        # workspace_slug alone is allowed but matches no project → empty list
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": "00000000-0000-0000-0000-000000000000"},
        )
        assert r.status_code == 200
        assert r.json()["bindings"] == []


@pytest.mark.contract
class TestIssueLinkLookupByPlaneIssueId:
    """Phase 4e: outbound dispatcher looks up the link by Plane issue id
    to short-circuit duplicate creates."""

    PATH = "/api/v1/silo/github/issue-link/lookup/"

    def _make_link(self, db, project, github_workspace_connection):
        return WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=project,
            type="github-issue-link",
            entity_type="issue",
            entity_id="9999",
            entity_slug="zebaria/plane",
            issue_id=None,
            entity_data={"gh_issue_number": 42, "gh_repo_full_name": "zebaria/plane"},
            config={"plane_project_id": str(project.id)},
        )

    def test_lookup_by_plane_issue_id(self, db, api_client, settings, project, github_workspace_connection):

        state = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        issue = Issue.objects.create(
            name="Test", workspace=project.workspace, project=project, state=state
        )
        link = self._make_link(db, project, github_workspace_connection)
        link.issue_id = issue.id
        link.save()

        r = _post_silo(api_client, settings, self.PATH, {"plane_issue_id": str(issue.id)})
        assert r.status_code == 200, r.content
        body = r.json()
        assert body["plane_issue_id"] == str(issue.id)
        assert body["entity_id"] == "9999"
        assert body["entity_data"]["gh_issue_number"] == 42

    def test_lookup_missing_returns_404(self, db, api_client, settings):
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"plane_issue_id": "00000000-0000-0000-0000-000000000000"},
        )
        assert r.status_code == 404

    def test_neither_id_400(self, db, api_client, settings):
        r = _post_silo(api_client, settings, self.PATH, {})
        assert r.status_code == 400


@pytest.mark.contract
class TestIssueLinkPlaneCommentMap:
    """Phase 4e: outbound persists plane_comment_map[plane_id]=gh_id on
    the link row's entity_data so retries don't double-post."""

    LINK_PATH = "/api/v1/silo/github/issue-link/"

    def test_plane_comment_map_merged(
        self, db, api_client, settings, project, github_workspace_connection
    ):

        state = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        issue = Issue.objects.create(
            name="Test", workspace=project.workspace, project=project, state=state
        )

        # First write seeds the link with one plane→gh comment mapping.
        r = _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(project.id),
                "gh_issue_id": "5555",
                "gh_issue_number": 7,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": str(issue.id),
                "plane_project_id": str(project.id),
                "plane_comment_map": {"plane-c-1": "100"},
            },
        )
        assert r.status_code == 200, r.content

        link = WorkspaceEntityConnection.objects.get(
            workspace_connection=github_workspace_connection,
            type="github-issue-link",
            entity_id="5555",
        )
        assert link.entity_data["plane_comment_map"] == {"plane-c-1": "100"}

        # Second write with a different mapping replaces (caller must
        # send merged map; we don't partial-merge server-side).
        _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(project.id),
                "gh_issue_id": "5555",
                "gh_issue_number": 7,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": str(issue.id),
                "plane_project_id": str(project.id),
                "plane_comment_map": {"plane-c-1": "100", "plane-c-2": "200"},
            },
        )
        link.refresh_from_db()
        assert link.entity_data["plane_comment_map"] == {
            "plane-c-1": "100",
            "plane-c-2": "200",
        }

    def test_gh_and_plane_comment_maps_coexist(
        self, db, api_client, settings, project, github_workspace_connection
    ):

        state = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        issue = Issue.objects.create(
            name="Test", workspace=project.workspace, project=project, state=state
        )

        _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(project.id),
                "gh_issue_id": "5555",
                "gh_issue_number": 7,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": str(issue.id),
                "plane_project_id": str(project.id),
                "gh_comment_map": {"100": "plane-c-1"},
            },
        )
        _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(project.id),
                "gh_issue_id": "5555",
                "gh_issue_number": 7,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": str(issue.id),
                "plane_project_id": str(project.id),
                "plane_comment_map": {"plane-c-2": "200"},
            },
        )

        link = WorkspaceEntityConnection.objects.get(
            workspace_connection=github_workspace_connection,
            type="github-issue-link",
            entity_id="5555",
        )
        # Both maps are merged into entity_data — the gh_comment_map
        # from the first write must survive the second write that only
        # touched plane_comment_map.
        assert link.entity_data["gh_comment_map"] == {"100": "plane-c-1"}
        assert link.entity_data["plane_comment_map"] == {"plane-c-2": "200"}


@pytest.mark.contract
class TestCreateWorkItemDescriptionHtml:
    """Phase 4e: silo work-item create accepts description_html
    (rendered HTML from GH's marked) AND the legacy plain-text
    description (Slack action submits). They must not collide."""

    PATH = "/api/v1/silo/work-items/"

    def test_description_html_passthrough(
        self, db, api_client, settings, project, github_credential
    ):
        # github_credential gives the endpoint a fall-back actor when
        # gh_user_login is unmapped — required for the create to
        # succeed without explicit actor_user_id.
        del github_credential  # fixture only — referenced for side-effect
        html = "<h3>Heading</h3><p>body</p>"
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "workspace_slug": project.workspace.slug,
                "project_id": str(project.id),
                "title": "from GH",
                "description_html": html,
                "gh_user_login": "alice",
            },
        )
        assert r.status_code in (200, 201), r.content


        issue = Issue.objects.get(pk=r.json()["id"])
        # Tags must NOT be HTML-escaped — GH path passes already-HTML.
        assert "<h3>" in issue.description_html
        assert "&lt;h3&gt;" not in issue.description_html

    def test_plain_description_still_escaped_for_slack_path(
        self, db, api_client, settings, project, github_credential
    ):
        # Slack action submits send raw user text in `description`. Tags
        # must be escaped + wrapped in <p> so the editor doesn't choke.
        del github_credential
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "workspace_slug": project.workspace.slug,
                "project_id": str(project.id),
                "title": "from Slack",
                "description": "user typed <script>alert(1)</script>",
                "gh_user_login": "alice",
            },
        )
        assert r.status_code in (200, 201), r.content


        issue = Issue.objects.get(pk=r.json()["id"])
        # Tags escaped, wrapped in <p>.
        assert "&lt;script&gt;" in issue.description_html
        assert "<script>" not in issue.description_html
        assert issue.description_html.startswith("<p>")


@pytest.mark.contract
class TestPrStateMapResolution:
    """Phase 4f: PR state map resolves workspace default + per-project
    override. Silo calls this on each pull_request event to translate
    the PR lifecycle into a Plane state_id."""

    PATH = "/api/v1/silo/github/pr-state-map/"

    def test_neither_mode_supplied_400(self, db, api_client, settings):
        r = _post_silo(api_client, settings, self.PATH, {})
        assert r.status_code == 400

    def test_empty_when_no_rows(self, db, api_client, settings, project):
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": str(project.id)},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["map"] == {}
        assert body["scope"] is None

    def test_workspace_default_returned(
        self, db, api_client, settings, project, github_workspace_connection
    ):
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=None,
            type="github-pr-state-map",
            entity_type="pr-state-map",
            entity_id="ws-default",
            config={"prStateMap": {"merged": "S_DONE", "draft": "S_BACKLOG"}},
        )
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": str(project.id)},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["map"] == {"merged": "S_DONE", "draft": "S_BACKLOG"}
        assert body["scope"] == "workspace"

    def test_project_override_layers_on_default(
        self, db, api_client, settings, project, github_workspace_connection
    ):
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=None,
            type="github-pr-state-map",
            entity_type="pr-state-map",
            entity_id="ws-default",
            config={"prStateMap": {"merged": "S_DONE", "draft": "S_BACKLOG"}},
        )
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=project,
            type="github-pr-state-map",
            entity_type="pr-state-map",
            entity_id="proj-override",
            config={"prStateMap": {"merged": "S_PROJ_DONE", "approved": "S_REVIEWED"}},
        )
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": str(project.id)},
        )
        body = r.json()
        # `merged` overridden by project, `draft` inherited from default,
        # `approved` added by project.
        assert body["map"] == {
            "merged": "S_PROJ_DONE",
            "draft": "S_BACKLOG",
            "approved": "S_REVIEWED",
        }
        assert body["scope"] == "project"

    def test_empty_string_values_dropped(
        self, db, api_client, settings, project, github_workspace_connection
    ):
        # FE writes "" to clear a row; resolver treats absence == "" so
        # silo's "no entry → leave state alone" rule applies.
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=None,
            type="github-pr-state-map",
            entity_type="pr-state-map",
            entity_id="ws-default",
            config={"prStateMap": {"merged": "S_DONE", "draft": ""}},
        )
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"workspace_slug": project.workspace.slug, "project_id": str(project.id)},
        )
        body = r.json()
        assert body["map"] == {"merged": "S_DONE"}

    def test_lookup_via_installation_and_repo(
        self, db, api_client, settings, project, github_workspace_connection, repo_binding
    ):
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection,
            project=project,
            type="github-pr-state-map",
            entity_type="pr-state-map",
            entity_id="proj-override",
            config={"prStateMap": {"opened": "S_OPEN"}},
        )
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"installation_id": "42", "repo_id": "999"},
        )
        body = r.json()
        assert body["project_id"] == str(project.id)
        assert body["map"] == {"opened": "S_OPEN"}

    def test_lookup_via_installation_with_unknown_repo_returns_empty(
        self, db, api_client, settings, github_workspace_connection
    ):
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {"installation_id": "42", "repo_id": "9999999"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["map"] == {}
        assert body["scope"] is None


@pytest.mark.contract
class TestIssueLinkOwnershipScoping:
    """Post-review hardening: SiloGithubIssueLinkEndpoint must reject a
    project_id / plane_issue_id that doesn't belong to the connection's
    workspace, so a silo-side mixup can't link a GH issue to another
    workspace's work item."""

    LINK_PATH = "/api/v1/silo/github/issue-link/"

    def _issue_in(self, project):

        state = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        return Issue.objects.create(
            name="WI", workspace=project.workspace, project=project, state=state
        )

    def test_foreign_project_id_rejected(
        self, db, api_client, settings, project, github_workspace_connection, create_user
    ):

        other_ws = Workspace.objects.create(
            name="Other", owner=create_user, slug="other-ws"
        )
        WorkspaceMember.objects.create(workspace=other_ws, member=create_user, role=20)
        other_project = Project.objects.create(
            name="Other", identifier="OTH", workspace=other_ws
        )
        other_issue = self._issue_in(other_project)

        # Connection is in `project.workspace`, but we pass the other
        # workspace's project + issue → must 400.
        r = _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(other_project.id),
                "gh_issue_id": "7777",
                "gh_issue_number": 1,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": str(other_issue.id),
                "plane_project_id": str(other_project.id),
            },
        )
        assert r.status_code == 400, r.content
        assert not WorkspaceEntityConnection.objects.filter(
            type="github-issue-link", entity_id="7777"
        ).exists()

    def test_foreign_issue_in_valid_project_rejected(
        self, db, api_client, settings, project, github_workspace_connection
    ):
        # Right workspace + project, but an issue id that isn't in that
        # project → 400.
        r = _post_silo(
            api_client,
            settings,
            self.LINK_PATH,
            {
                "workspace_connection_id": str(github_workspace_connection.id),
                "project_id": str(project.id),
                "gh_issue_id": "7778",
                "gh_issue_number": 2,
                "gh_repo_full_name": "zebaria/plane",
                "plane_issue_id": "00000000-0000-0000-0000-000000000000",
                "plane_project_id": str(project.id),
            },
        )
        assert r.status_code == 400, r.content


@pytest.mark.contract
class TestCommentUpdateScoping:
    """Post-review hardening: SiloUpdateCommentEndpoint scopes the
    comment lookup by (workspace_slug, issue_id) so a bad comment_id
    can't edit/delete an arbitrary comment."""

    PATH = "/api/v1/silo/comments/update/"

    def _comment(self, project):

        state = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        issue = Issue.objects.create(
            name="WI", workspace=project.workspace, project=project, state=state
        )
        comment = IssueComment.objects.create(
            workspace=project.workspace,
            project=project,
            issue=issue,
            comment_html="<p>original</p>",
        )
        return issue, comment

    def test_requires_scope_fields(self, db, api_client, settings, project):
        _issue, comment = self._comment(project)
        r = _post_silo(
            api_client, settings, self.PATH, {"comment_id": str(comment.id), "action": "edit"}
        )
        assert r.status_code == 400, r.content

    def test_edit_within_scope_succeeds(self, db, api_client, settings, project):
        issue, comment = self._comment(project)
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "comment_id": str(comment.id),
                "action": "edit",
                "comment_html": "<p>edited</p>",
                "workspace_slug": project.workspace.slug,
                "issue_id": str(issue.id),
            },
        )
        assert r.status_code == 200, r.content
        comment.refresh_from_db()
        assert comment.comment_html == "<p>edited</p>"

    def test_wrong_issue_id_is_noop_missing(self, db, api_client, settings, project):

        issue, comment = self._comment(project)
        del issue
        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "comment_id": str(comment.id),
                "action": "delete",
                "workspace_slug": project.workspace.slug,
                # A different (nonexistent) issue id → out of scope.
                "issue_id": "00000000-0000-0000-0000-000000000000",
            },
        )
        assert r.status_code == 200, r.content
        assert r.json().get("missing") is True
        # Comment must NOT have been deleted.
        assert IssueComment.objects.filter(pk=comment.id).exists()


@pytest.mark.contract
class TestReposChangedMerge:
    """Post-review fix: installation_repositories carries only the
    delta, so repos_changed must MERGE into the cached list rather than
    replacing it with just the delta."""

    PATH = "/api/v1/silo/github/install-lifecycle/"

    def test_added_merges_into_existing(
        self, db, api_client, settings, github_workspace_connection
    ):
        github_workspace_connection.connection_data = {
            "repositories": [
                {"id": "1", "full_name": "z/one"},
                {"id": "2", "full_name": "z/two"},
            ]
        }
        github_workspace_connection.save(update_fields=["connection_data"])

        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "action": "repos_changed",
                "installation_id": "42",
                "repositories_added": [{"id": "3", "full_name": "z/three"}],
                "repositories_removed": [],
            },
        )
        assert r.status_code == 200, r.content
        github_workspace_connection.refresh_from_db()
        ids = {r["id"] for r in github_workspace_connection.connection_data["repositories"]}
        # Existing repos preserved, new one added — NOT clobbered to just [3].
        assert ids == {"1", "2", "3"}

    def test_removed_drops_only_that_repo(
        self, db, api_client, settings, github_workspace_connection
    ):
        github_workspace_connection.connection_data = {
            "repositories": [
                {"id": "1", "full_name": "z/one"},
                {"id": "2", "full_name": "z/two"},
            ]
        }
        github_workspace_connection.save(update_fields=["connection_data"])

        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "action": "repos_changed",
                "installation_id": "42",
                "repositories_added": [],
                "repositories_removed": [{"id": "1", "full_name": "z/one"}],
            },
        )
        assert r.status_code == 200, r.content
        github_workspace_connection.refresh_from_db()
        ids = {r["id"] for r in github_workspace_connection.connection_data["repositories"]}
        assert ids == {"2"}


@pytest.mark.contract
class TestUpdateWorkItemCompletedAt:
    """Post-review fix: the work-item update endpoint must go through
    issue.save() (not queryset .update()) so the model's
    _sync_completed_at hook fires. Otherwise a GH-driven close never
    stamps completed_at, and a reopen never clears it.
    """

    PATH = "/api/v1/silo/work-items/update/"

    def _issue_with_states(self, project):

        backlog = State.objects.create(
            name="Backlog", workspace=project.workspace, project=project, group="backlog"
        )
        done = State.objects.create(
            name="Done", workspace=project.workspace, project=project, group="completed"
        )
        issue = Issue.objects.create(
            name="WI", workspace=project.workspace, project=project, state=backlog
        )
        return issue, backlog, done

    def test_move_to_completed_stamps_completed_at(
        self, db, api_client, settings, project, github_credential
    ):
        del github_credential  # actor fallback for the endpoint
        issue, _backlog, done = self._issue_with_states(project)
        assert issue.completed_at is None

        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "workspace_slug": project.workspace.slug,
                "project_id": str(project.id),
                "issue_id": str(issue.id),
                "state_id": str(done.id),
            },
        )
        assert r.status_code == 200, r.content
        issue.refresh_from_db()
        # The whole point of the fix: _sync_completed_at ran on save.
        assert issue.completed_at is not None

    def test_reopen_clears_completed_at(
        self, db, api_client, settings, project, github_credential
    ):
        del github_credential

        issue, backlog, done = self._issue_with_states(project)
        # Start already-completed so the reopen has something to clear.
        issue.state = done
        issue.completed_at = timezone.now()
        issue.save()
        assert issue.completed_at is not None

        r = _post_silo(
            api_client,
            settings,
            self.PATH,
            {
                "workspace_slug": project.workspace.slug,
                "project_id": str(project.id),
                "issue_id": str(issue.id),
                "state_id": str(backlog.id),
            },
        )
        assert r.status_code == 200, r.content
        issue.refresh_from_db()
        assert issue.completed_at is None