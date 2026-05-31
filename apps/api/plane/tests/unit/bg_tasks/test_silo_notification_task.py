# Copyright (c) 2026-present Zebaria.
# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for plane.bgtasks.silo_notification_task.

Covers the dispatch task that fans Plane work-item events out to silo:
  - No mappings → fast no-op (no HTTP request)
  - work_item.created emits the right payload shape
  - issue.activity.updated narrows to state_changed/completed by inspecting diff
  - work_item.commented hydrates comment_text via _render_comment_for_slack
  - Mention rendering: <mention-component> → <@SLACK_UID> for mapped users,
    @display_name for unmapped
  - dm_targets: assignees + mentions, minus self when SILO_DM_SKIP_SELF=True
  - SILO_DM_SKIP_SELF=False → self DMs allowed (solo-dev mode)
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from django.test import override_settings

from plane.bgtasks.silo_notification_task import (
    GITHUB_REPO_TYPE,
    INTEGRATION_MAPPING_TYPES,
    INTEGRATIONS,
    SLACK_NOTIFICATION_TYPE,
    _gh_mention_map,
    _render_comment_for_slack,
    dispatch_silo_work_item_event,
)
from plane.connections.models import (
    WorkspaceConnection,
    WorkspaceCredential,
    WorkspaceEntityConnection,
    WorkspaceUserConnection,
)
from plane.db.models import Issue, IssueComment, Project, ProjectMember, State


# ============================================================
# Fixtures specific to silo notification tests
# ============================================================


@pytest.fixture
def project(db, create_user, workspace):
    p = Project.objects.create(
        name="Test", identifier="TST", workspace=workspace
    )
    ProjectMember.objects.create(project=p, member=create_user)
    return p


@pytest.fixture
def slack_credential(db, project, create_user):
    return WorkspaceCredential.objects.create(
        workspace=project.workspace,
        user=create_user,
        source="slack",
        source_identifier="T07TEAM",
        source_access_token="xoxb-fake",
        is_pat=False,
        is_active=True,
    )


@pytest.fixture
def slack_workspace_connection(db, project, slack_credential):
    return WorkspaceConnection.objects.create(
        workspace=project.workspace,
        credential=slack_credential,
        connection_type="slack",
        connection_id="T07TEAM",
        connection_slug="Test Team",
    )


@pytest.fixture
def slack_channel_mapping(db, project, slack_workspace_connection):
    return WorkspaceEntityConnection.objects.create(
        workspace=project.workspace,
        workspace_connection=slack_workspace_connection,
        project=project,
        type=SLACK_NOTIFICATION_TYPE,
        entity_type="slack-channel",
        entity_id="C0CHAN",
        entity_slug="general",
        config={"events": ["work_item.created", "work_item.commented"]},
    )


@pytest.fixture
def issue_factory(db, project, create_user, workspace):
    """Build issues bound to the test project with a state."""

    def _build(
        name: str = "Test Issue",
        state_group: str = "backlog",
        priority: str = "none",
        description_html: str = "",
    ) -> Issue:
        state, _ = State.objects.get_or_create(
            name=state_group.title(),
            workspace=workspace,
            project=project,
            defaults={"group": state_group},
        )
        i = Issue.objects.create(
            name=name,
            workspace=workspace,
            project=project,
            state=state,
            priority=priority,
            description_html=description_html,
        )
        return i

    return _build


# ============================================================
# Tests
# ============================================================


@pytest.mark.unit
class TestDispatchSiloWorkItemEventNoOp:
    """When the project has no mappings, the task must not make HTTP calls."""

    def test_no_mappings_returns_immediately(self, db, project, create_user):
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=None,
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        mock_post.assert_not_called()

    def test_unhandled_activity_type_returns_immediately(self, db, project, slack_channel_mapping):
        """activity types not in ACTIVITY_EVENT_MAP should be ignored."""
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            dispatch_silo_work_item_event(
                activity_type="cycle.activity.created",
                issue_id=None,
                project_id=str(slack_channel_mapping.project_id),
                actor_id=None,
            )
        mock_post.assert_not_called()


@pytest.mark.unit
class TestDispatchPayloadShape:
    """Verify the payload silo receives matches what notifications.ts expects."""

    def _captured_payload(self, mock_post) -> dict:
        """Pull the JSON body silo would receive from the mock."""
        assert mock_post.call_count == 1
        kwargs = mock_post.call_args.kwargs
        return json.loads(kwargs["data"])

    def test_created_payload(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        issue = issue_factory(name="hello", priority="high")
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        payload = self._captured_payload(mock_post)
        assert payload["event_type"] == "work_item.created"
        assert payload["workspace_slug"] == project.workspace.slug
        assert payload["project_identifier"] == project.identifier
        assert payload["issue"]["id"] == str(issue.id)
        assert payload["issue"]["name"] == "hello"
        assert payload["issue"]["priority"] == "high"
        assert payload["actor"]["id"] == str(create_user.id)

    def test_no_state_change_no_op(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        """issue.activity.updated without a state change → no fan-out
        (we only care about state changes for Slack v1)."""
        issue = issue_factory()
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            dispatch_silo_work_item_event(
                activity_type="issue.activity.updated",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
                requested_data=json.dumps({"name": "renamed"}),
                current_instance=json.dumps({"name": "original"}),
            )
        mock_post.assert_not_called()

    def test_state_change_emits_state_changed(
        self, db, project, slack_channel_mapping, issue_factory, create_user, workspace
    ):
        issue = issue_factory()
        # issue_factory created the "Backlog" state already.
        from_state = State.objects.get(name="Backlog", project=project)
        to_state = State.objects.create(
            name="In Progress", workspace=workspace, project=project, group="started"
        )
        # Make the channel listen to state_changed
        m = slack_channel_mapping
        m.config = {"events": ["work_item.state_changed"]}
        m.save()

        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.updated",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
                requested_data=json.dumps({"state_id": str(to_state.id)}),
                current_instance=json.dumps({"state_id": str(from_state.id)}),
            )
        payload = self._captured_payload(mock_post)
        assert payload["event_type"] == "work_item.state_changed"
        assert payload["state_change"]["from_name"] == "Backlog"
        assert payload["state_change"]["to_name"] == "In Progress"
        assert payload["state_change"]["from_group"] == "backlog"
        assert payload["state_change"]["to_group"] == "started"

    def test_completed_group_emits_completed(
        self, db, project, slack_channel_mapping, issue_factory, create_user, workspace
    ):
        issue = issue_factory()
        from_state = State.objects.create(
            name="In Progress", workspace=workspace, project=project, group="started"
        )
        done_state = State.objects.create(
            name="Done", workspace=workspace, project=project, group="completed"
        )
        slack_channel_mapping.config = {"events": ["work_item.completed"]}
        slack_channel_mapping.save()

        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.updated",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
                requested_data=json.dumps({"state_id": str(done_state.id)}),
                current_instance=json.dumps({"state_id": str(from_state.id)}),
            )
        payload = self._captured_payload(mock_post)
        assert payload["event_type"] == "work_item.completed"
        assert payload["state_change"]["to_group"] == "completed"


@pytest.mark.unit
class TestDmTargets:
    """Per-user DM target resolution."""

    def _get_payload(self, mock_post) -> dict:
        assert mock_post.call_count == 1
        return json.loads(mock_post.call_args.kwargs["data"])

    def test_self_assignment_skipped_by_default(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        """Default SILO_DM_SKIP_SELF=True drops the actor from dm_targets."""
        WorkspaceUserConnection.objects.create(
            workspace=project.workspace,
            user=create_user,
            credential=slack_channel_mapping.workspace_connection.credential,
            connection_type="slack",
            connection_id="U07SELF",
        )
        issue = issue_factory()
        with patch.dict("os.environ", {"SILO_DM_SKIP_SELF": "True"}, clear=False), patch(
            "plane.bgtasks.silo_notification_task.requests.post"
        ) as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
                requested_data=json.dumps({"assignee_ids": [str(create_user.id)]}),
            )
        payload = self._get_payload(mock_post)
        assert payload["dm_targets"] == []

    def test_self_assignment_kept_when_skip_self_disabled(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        """SILO_DM_SKIP_SELF=False (solo-dev mode) keeps the actor as a target."""
        WorkspaceUserConnection.objects.create(
            workspace=project.workspace,
            user=create_user,
            credential=slack_channel_mapping.workspace_connection.credential,
            connection_type="slack",
            connection_id="U07SELF",
        )
        issue = issue_factory()
        with patch.dict("os.environ", {"SILO_DM_SKIP_SELF": "False"}, clear=False), patch(
            "plane.bgtasks.silo_notification_task.requests.post"
        ) as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
                requested_data=json.dumps({"assignee_ids": [str(create_user.id)]}),
            )
        payload = self._get_payload(mock_post)
        assert len(payload["dm_targets"]) == 1
        assert payload["dm_targets"][0]["slack_user_id"] == "U07SELF"


# ============================================================
# Mention rendering
# ============================================================


@pytest.mark.unit
class TestRenderCommentForSlack:
    """The HTML→Slack-mrkdwn conversion that re-renders Plane mentions."""

    def test_no_mentions_returns_stripped_text(self, db, project, create_user, workspace):
        from plane.db.models import Issue

        issue = Issue.objects.create(name="i", workspace=workspace, project=project)
        comment = IssueComment.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            comment_html="<p>just a plain comment</p>",
            comment_stripped="just a plain comment",
        )
        out = _render_comment_for_slack(comment, str(workspace.id))
        assert out == "just a plain comment"

    def test_mapped_user_rendered_as_slack_mention(
        self, db, project, slack_credential, create_user, workspace
    ):
        WorkspaceUserConnection.objects.create(
            workspace=workspace,
            user=create_user,
            credential=slack_credential,
            connection_type="slack",
            connection_id="U07USER",
        )
        from plane.db.models import Issue

        issue = Issue.objects.create(name="i", workspace=workspace, project=project)
        comment_html = (
            f'<p>hey <mention-component entity_identifier="{create_user.id}" '
            f'entity_name="user_mention"></mention-component> ready</p>'
        )
        comment = IssueComment.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            comment_html=comment_html,
            comment_stripped="hey  ready",
        )
        out = _render_comment_for_slack(comment, str(workspace.id))
        assert "<@U07USER>" in out
        # Original tag must be gone
        assert "mention-component" not in out

    def test_unmapped_user_falls_back_to_display_name(
        self, db, project, create_user, workspace
    ):
        """Mentioned user with NO Slack mapping → @DisplayName fallback."""
        from plane.db.models import Issue

        issue = Issue.objects.create(name="i", workspace=workspace, project=project)
        comment_html = (
            f'<p>hi <mention-component entity_identifier="{create_user.id}" '
            f'entity_name="user_mention"></mention-component></p>'
        )
        comment = IssueComment.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            comment_html=comment_html,
            comment_stripped="hi ",
        )
        out = _render_comment_for_slack(comment, str(workspace.id))
        # Should contain @<something> referring to the user, not the slack uid
        assert "@" in out
        assert "<@U" not in out

    def test_no_html_returns_empty(self, db, project, create_user, workspace):
        from plane.db.models import Issue

        issue = Issue.objects.create(name="i", workspace=workspace, project=project)
        comment = IssueComment.objects.create(
            issue=issue,
            project=project,
            workspace=workspace,
            actor=create_user,
            comment_html="",
            comment_stripped="",
        )
        out = _render_comment_for_slack(comment, str(workspace.id))
        assert out == ""


# ============================================================
# INTEGRATIONS registry — Phase 4e
# ============================================================


@pytest.mark.unit
class TestIntegrationsRegistry:
    """The dispatcher fans out to whatever integrations have a live
    mapping on the project. Adding a new integration should be one
    tuple entry — no orchestrator branches. These tests pin the
    contract so a refactor doesn't silently drop subscribers.
    """

    def test_registry_has_slack_and_github(self):
        types = {i["mapping_type"] for i in INTEGRATIONS}
        assert SLACK_NOTIFICATION_TYPE in types
        assert GITHUB_REPO_TYPE in types

    def test_integration_mapping_types_matches_registry(self):
        # The flat tuple is what the existence-check filter uses; if
        # it falls out of sync with the registry, the dispatcher
        # silently stops fanning out to the missing type.
        assert set(INTEGRATION_MAPPING_TYPES) == {i["mapping_type"] for i in INTEGRATIONS}

    def test_each_integration_declares_event_subscription(self):
        for i in INTEGRATIONS:
            assert "events" in i
            assert isinstance(i["events"], (tuple, list))
            assert len(i["events"]) > 0

    def test_github_subscribes_to_create_update_state_comment_completed(self):
        gh = next(i for i in INTEGRATIONS if i["mapping_type"] == GITHUB_REPO_TYPE)
        events = set(gh["events"])
        # Outbound mirror needs all four lifecycle hooks. If we drop
        # `work_item.updated` here the title/description edit path
        # silently breaks on GitHub.
        for required in (
            "work_item.created",
            "work_item.updated",
            "work_item.state_changed",
            "work_item.commented",
            "work_item.completed",
        ):
            assert required in events, f"github integration missing {required}"


@pytest.mark.unit
class TestLiveMappingTypesPayload:
    """Phase 4e payload: silo dispatchers self-gate on
    `live_mapping_types`. The payload must list the types of mappings
    actually live on the project, so the dispatcher knows whether to
    run."""

    def _captured(self, mock_post) -> dict:
        assert mock_post.call_count == 1
        return json.loads(mock_post.call_args.kwargs["data"])

    def test_payload_includes_live_mapping_types(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        issue = issue_factory()
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        payload = self._captured(mock_post)
        assert "live_mapping_types" in payload
        assert SLACK_NOTIFICATION_TYPE in payload["live_mapping_types"]

    def test_github_only_project_dispatches(
        self, db, project, github_workspace_connection_for_test, issue_factory, create_user
    ):
        """A project bound only to a GitHub repo (no Slack channel
        mapping) must still trigger the dispatch — the registry
        existence check is `type__in=INTEGRATION_MAPPING_TYPES`,
        not `type=SLACK_NOTIFICATION_TYPE`."""
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection_for_test,
            project=project,
            type=GITHUB_REPO_TYPE,
            entity_type="repository",
            entity_id="999",
            entity_slug="zebaria/plane",
            config={"direction": "bi"},
        )
        issue = issue_factory()
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        payload = self._captured(mock_post)
        assert GITHUB_REPO_TYPE in payload["live_mapping_types"]


@pytest.mark.unit
class TestGhMentionMap:
    """Phase 4e followup: outbound's `@mention` rewrite needs a
    plane_user_id → gh_login map in the payload. The helper builds it
    by parsing `<mention-component>` tags out of the description and
    comment html, then joining to WorkspaceUserConnection rows of
    type=github."""

    def _make_gh_user_conn(self, db, project, create_user, gh_login: str):
        cred = WorkspaceCredential.objects.create(
            workspace=project.workspace,
            user=create_user,
            source="github",
            source_identifier="42",
            source_access_token="ghs_fake",
            is_pat=False,
            is_active=True,
        )
        return WorkspaceUserConnection.objects.create(
            workspace=project.workspace,
            user=create_user,
            credential=cred,
            connection_type="github",
            connection_id="999",
            connection_slug=gh_login,
        )

    def test_returns_empty_when_no_mention_components(self, db, project):
        out = _gh_mention_map(["<p>plain text</p>"], str(project.workspace_id))
        assert out == {}

    def test_returns_empty_when_no_mapped_user(self, db, project, create_user):
        # mention exists but the Plane user has no github WorkspaceUserConnection
        html = (
            f'<p><mention-component entity_name="user_mention" '
            f'entity_identifier="{create_user.id}">@Erik</mention-component></p>'
        )
        out = _gh_mention_map([html], str(project.workspace_id))
        assert out == {}

    def test_resolves_mapped_user_to_gh_login(self, db, project, create_user):
        self._make_gh_user_conn(db, project, create_user, "alice-gh")
        html = (
            f'<p><mention-component entity_name="user_mention" '
            f'entity_identifier="{create_user.id}">@Erik</mention-component></p>'
        )
        out = _gh_mention_map([html], str(project.workspace_id))
        assert out == {str(create_user.id): "alice-gh"}

    def test_ignores_non_user_mention_types(self, db, project, create_user):
        self._make_gh_user_conn(db, project, create_user, "alice-gh")
        html = (
            f'<p><mention-component entity_name="project_mention" '
            f'entity_identifier="{create_user.id}">#Proj</mention-component></p>'
        )
        out = _gh_mention_map([html], str(project.workspace_id))
        assert out == {}

    def test_ignores_invalid_uuids(self, db, project):
        html = (
            '<p><mention-component entity_name="user_mention" '
            'entity_identifier="not-a-uuid">@x</mention-component></p>'
        )
        out = _gh_mention_map([html], str(project.workspace_id))
        assert out == {}

    def test_mention_map_in_payload_when_github_live(
        self, db, project, github_workspace_connection_for_test, issue_factory, create_user
    ):
        # Bind GH so live_mapping_types contains github-repo
        WorkspaceEntityConnection.objects.create(
            workspace=project.workspace,
            workspace_connection=github_workspace_connection_for_test,
            project=project,
            type=GITHUB_REPO_TYPE,
            entity_type="repository",
            entity_id="999",
            entity_slug="zebaria/plane",
            config={"direction": "bi"},
        )
        # Map create_user → gh login
        TestGhMentionMap()._make_gh_user_conn(db, project, create_user, "alice-gh")

        # Issue's description_html mentions the user
        mention_html = (
            f'<p><mention-component entity_name="user_mention" '
            f'entity_identifier="{create_user.id}">@Erik</mention-component></p>'
        )
        issue = issue_factory(description_html=mention_html)
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        payload = json.loads(mock_post.call_args.kwargs["data"])
        assert payload.get("mention_map") == {str(create_user.id): "alice-gh"}

    def test_mention_map_empty_when_github_not_live(
        self, db, project, slack_channel_mapping, issue_factory, create_user
    ):
        # Slack-only project — payload still has mention_map but it's
        # empty (we don't pay the WorkspaceUserConnection query cost
        # when no GH dispatcher will consume it).
        TestGhMentionMap()._make_gh_user_conn(db, project, create_user, "alice-gh")
        mention_html = (
            f'<p><mention-component entity_name="user_mention" '
            f'entity_identifier="{create_user.id}">@Erik</mention-component></p>'
        )
        issue = issue_factory(description_html=mention_html)
        with patch("plane.bgtasks.silo_notification_task.requests.post") as mock_post:
            mock_post.return_value.status_code = 200
            dispatch_silo_work_item_event(
                activity_type="issue.activity.created",
                issue_id=str(issue.id),
                project_id=str(project.id),
                actor_id=str(create_user.id),
            )
        payload = json.loads(mock_post.call_args.kwargs["data"])
        assert payload.get("mention_map") == {}


@pytest.fixture
def github_workspace_connection_for_test(db, project, create_user):
    """A WorkspaceConnection of type=github so we can attach a
    github-repo entity mapping to the project for the registry tests
    without touching the Slack fixtures."""
    cred = WorkspaceCredential.objects.create(
        workspace=project.workspace,
        user=create_user,
        source="github",
        source_identifier="42",
        source_access_token="ghs_fake",
        is_pat=False,
        is_active=True,
    )
    return WorkspaceConnection.objects.create(
        workspace=project.workspace,
        credential=cred,
        connection_type="github",
        connection_id="42",
        connection_slug="zebaria",
    )