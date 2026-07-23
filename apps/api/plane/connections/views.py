# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""V1 endpoints silo calls back into Django on.

Mounted under `/api/v1/` (see plane/urls.py → plane/api/urls). All
endpoints are workspace-scoped via the `<slug>` URL kwarg. Path names
match what silo's bundled client expects:

  /api/v1/workspaces/<slug>/workspace-credentials/
  /api/v1/workspaces/<slug>/workspace-credentials/<id>/
  /api/v1/workspaces/<slug>/workspace-credentials/token-verify/
  /api/v1/workspaces/<slug>/workspace-connections/
  /api/v1/workspaces/<slug>/workspace-connections/<id>/
  /api/v1/workspaces/<slug>/workspace-user-connections/
  /api/v1/workspaces/<slug>/workspace-user-connections/<id>/
  /api/v1/workspaces/<slug>/workspace-entity-connections/
  /api/v1/workspaces/<slug>/workspace-entity-connections/<id>/

Permission policy:
- Workspace ADMIN may write (POST/PATCH/DELETE) on workspace-level
  resources (credentials, connections, entity-connections).
- Any workspace member (ADMIN/MEMBER/GUEST) may read.
- Personal user-connections: only the owning user may write/delete
  their own rows; admins may delete any.
- Tokens are write-only on serializer output so they don't leak via
  list calls. silo stores them on POST and uses them server-side.
"""

import html as _html
import json as _json
from datetime import timedelta

from crum import get_current_user, set_current_user
from django.core.exceptions import ValidationError
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils import timezone as _tz
from rest_framework import status
from rest_framework.response import Response

from plane.api.serializers import IssueCommentSerializer, IssueSerializer
from plane.app.views.base import BaseAPIView
from plane.app.permissions import ROLE, allow_permission
from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import (
    Intake,
    IntakeIssue,
    Issue,
    IssueAssignee,
    IssueComment,
    IssueLabel,
    Label,
    Project,
    ProjectMember,
    State,
    StateGroup,
    User,
    Workspace,
    WorkspaceMember,
)
from plane.db.models.intake import SourceType
from plane.db.models.issue_type import ProjectIssueType

from .auth import IsSiloAuthenticated, SiloHMACAuthentication

from .models import (
    WorkspaceConnection,
    WorkspaceCredential,
    WorkspaceEntityConnection,
    WorkspaceUserConnection,
)
from .serializers import (
    WorkspaceConnectionSerializer,
    WorkspaceCredentialSerializer,
    WorkspaceEntityConnectionSerializer,
    WorkspaceUserConnectionSerializer,
)


def _workspace(slug):
    return get_object_or_404(Workspace, slug=slug)


# -- silo HMAC ping --------------------------------------------------------


class SiloPingEndpoint(BaseAPIView):
    """Liveness check for the silo↔Django HMAC channel.

    Bypasses APIKeyAuthentication / IsAuthenticated. Only callers that
    sign with SILO_HMAC_SECRET_KEY can reach this endpoint, so a 200
    proves the shared secret + signing scheme match end-to-end.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def get(self, request):
        return Response({"ok": True, "principal": "silo"})


class SiloSlackInstallEndpoint(BaseAPIView):
    """Persist a Slack workspace install completed by silo.

    Silo handles the OAuth dance and posts the resulting team token
    here. Idempotent on (workspace, source='slack', source_identifier
    = slack team id) for the credential and (workspace,
    connection_type='slack', connection_id=team id) for the
    connection.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        team_id = data.get("team_id")
        team_name = data.get("team_name") or ""
        bot_user_id = data.get("bot_user_id") or ""
        access_token = data.get("access_token")
        refresh_token = data.get("refresh_token") or ""
        expires_in = data.get("expires_in")
        scope = data.get("scope") or ""
        installer_user_id = data.get("installer_user_id")
        if not (slug and team_id and access_token and installer_user_id):
            return Response(
                {"detail": "workspace_slug, team_id, access_token, installer_user_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        installer = get_object_or_404(User, pk=installer_user_id)

        # Slack typically sends expires_in as an int, but accept stringy
        # numeric values too — silo passes the raw OAuth response through.
        expires_at = None
        if expires_in is not None:
            try:
                expires_in_val = int(expires_in)
                if expires_in_val > 0:
                    expires_at = timezone.now() + timedelta(seconds=expires_in_val)
            except (ValueError, TypeError):
                pass

        # Reinstall path: restore a previously soft-deleted row instead of
        # inserting a duplicate. The unique constraints are conditional on
        # `deleted_at IS NULL`, so multiple soft-deleted rows can exist for
        # the same lookup keys — `all_objects.update_or_create` would
        # MultipleObjectsReturned in that case. Prefer the live row, then
        # the most recent soft-deleted, then create.
        cred_defaults = {
            "user": installer,
            "source_access_token": access_token,
            "source_refresh_token": refresh_token,
            "source_token_expires_at": expires_at,
            "source_authorization_type": "OAUTH_ROTATING" if refresh_token else "OAUTH",
            "is_pat": False,
            "is_active": True,
            "deleted_at": None,
        }
        # Set crum + request.user to `installer` so BaseModel.save and any
        # save signals see the resolved actor instead of the anonymous silo
        # principal — otherwise created_by/updated_by audit columns land None.
        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(installer)
        request.user = installer
        try:
            cred = WorkspaceCredential.objects.filter(
                workspace=ws, source="slack", source_identifier=team_id
            ).first()
            if not cred:
                cred = (
                    WorkspaceCredential.all_objects.filter(
                        workspace=ws, source="slack", source_identifier=team_id
                    )
                    .order_by("-deleted_at")
                    .first()
                )
            if cred:
                for k, v in cred_defaults.items():
                    setattr(cred, k, v)
                cred.save()
            else:
                cred = WorkspaceCredential.objects.create(
                    workspace=ws, source="slack", source_identifier=team_id, **cred_defaults
                )

            conn_defaults = {
                "credential": cred,
                "connection_slug": team_name,
                "connection_data": {"bot_user_id": bot_user_id, "team_name": team_name},
                "scopes": [s for s in scope.split(",") if s],
                "config": {},
                "deleted_at": None,
            }
            conn = WorkspaceConnection.objects.filter(
                workspace=ws, connection_type="slack", connection_id=team_id
            ).first()
            if not conn:
                conn = (
                    WorkspaceConnection.all_objects.filter(
                        workspace=ws, connection_type="slack", connection_id=team_id
                    )
                    .order_by("-deleted_at")
                    .first()
                )
            if conn:
                for k, v in conn_defaults.items():
                    setattr(conn, k, v)
                conn.save()
            else:
                conn = WorkspaceConnection.objects.create(
                    workspace=ws, connection_type="slack", connection_id=team_id, **conn_defaults
                )
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user
        return Response(
            {
                "credential_id": str(cred.id),
                "connection_id": str(conn.id),
            },
            status=status.HTTP_200_OK,
        )


class SiloGithubInstallEndpoint(BaseAPIView):
    """Persist a GitHub App installation completed by silo.

    Silo handles the manifest + install dance and posts the resulting
    installation_id here. We don't store the installation token —
    GitHub mints fresh ones on demand and rotates them server-side, so
    silo re-mints from the App private key whenever it needs one.
    Idempotent on (workspace, source='github', source_identifier=
    installation_id) for the credential and (workspace,
    connection_type='github', connection_id=installation_id) for the
    connection.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        installation_id = data.get("installation_id")
        installer_user_id = data.get("installer_user_id")
        account_login = data.get("account_login") or ""
        account_id = data.get("account_id")
        account_type = data.get("account_type") or ""
        repository_selection = data.get("repository_selection") or "selected"
        # Phase 4g: GHES origin (e.g. "https://ghe.acme.com"). Stored
        # on connection_data so the bindings endpoint can surface it
        # to silo without an extra round-trip.
        ghes_base_url = data.get("ghes_base_url") or None
        if not (slug and installation_id and installer_user_id):
            return Response(
                {
                    "detail": "workspace_slug, installation_id, installer_user_id required"
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        installer = get_object_or_404(User, pk=installer_user_id)

        # The HMAC channel proves the request came from silo, but the
        # installer_user_id is just a value silo passed through from the
        # browser flow — verify it actually belongs to a workspace admin
        # before persisting anything against this workspace.
        if not WorkspaceMember.objects.filter(
            workspace=ws, member=installer, role=ROLE.ADMIN.value, is_active=True
        ).exists():
            return Response(
                {"detail": "installer must be an active admin of the workspace"},
                status=status.HTTP_403_FORBIDDEN,
            )

        cred_defaults = {
            "user": installer,
            # GitHub App installation tokens are 1h-lived and minted on
            # demand from the App private key — we deliberately don't
            # persist them. The non-empty source_authorization_type is
            # the marker that this is a live install.
            "source_access_token": "",
            "source_refresh_token": "",
            "source_token_expires_at": None,
            "source_authorization_type": "GITHUB_APP_INSTALLATION",
            "is_pat": False,
            "is_active": True,
            "deleted_at": None,
        }

        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(installer)
        request.user = installer
        try:
            with transaction.atomic():
                cred = WorkspaceCredential.objects.filter(
                    workspace=ws, source="github", source_identifier=str(installation_id)
                ).first()
                if not cred:
                    cred = (
                        WorkspaceCredential.all_objects.filter(
                            workspace=ws, source="github", source_identifier=str(installation_id)
                        )
                        .order_by("-deleted_at")
                        .first()
                    )
                if cred:
                    for k, v in cred_defaults.items():
                        setattr(cred, k, v)
                    cred.save()
                else:
                    cred = WorkspaceCredential.objects.create(
                        workspace=ws,
                        source="github",
                        source_identifier=str(installation_id),
                        **cred_defaults,
                    )

                conn_defaults = {
                    "credential": cred,
                    "connection_slug": account_login,
                    "connection_data": {
                        "account_login": account_login,
                        "account_id": account_id,
                        "account_type": account_type,
                        "repository_selection": repository_selection,
                        "ghes_base_url": ghes_base_url,
                    },
                    "scopes": [],
                    "config": {},
                    "deleted_at": None,
                }
                conn = WorkspaceConnection.objects.filter(
                    workspace=ws, connection_type="github", connection_id=str(installation_id)
                ).first()
                if not conn:
                    conn = (
                        WorkspaceConnection.all_objects.filter(
                            workspace=ws, connection_type="github", connection_id=str(installation_id)
                        )
                        .order_by("-deleted_at")
                        .first()
                    )
                if conn:
                    for k, v in conn_defaults.items():
                        setattr(conn, k, v)
                    conn.save()
                else:
                    conn = WorkspaceConnection.objects.create(
                        workspace=ws,
                        connection_type="github",
                        connection_id=str(installation_id),
                        **conn_defaults,
                    )
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user

        return Response(
            {"credential_id": str(cred.id), "connection_id": str(conn.id)},
            status=status.HTTP_200_OK,
        )


class SiloGithubUserConnectEndpoint(BaseAPIView):
    """Persist a per-user GitHub ↔ Plane mapping completed by silo.

    Mirrors SiloSlackUserConnectEndpoint: silo runs the user-scope
    OAuth dance against the per-env OAuth App, reads the GitHub
    user_id and login, and posts here. We never persist the user's
    OAuth access token — it's only needed at link time. The mapping
    is keyed on (workspace, user, connection_type='github') and is
    used purely for attribution at issue/comment-create time.

    Requires the workspace-level GitHub App install to exist first
    (the WorkspaceUserConnection FK to credential is non-null in the
    schema). Reuses that credential — there's no per-user token to
    keep separate, the OAuth App's role is purely identity-resolution
    at link time.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        plane_user_id = data.get("plane_user_id")
        github_user_id = data.get("github_user_id")
        github_login = data.get("github_login") or ""
        github_email = data.get("github_email") or ""

        if not (slug and plane_user_id and github_user_id and github_login):
            return Response(
                {"detail": "workspace_slug, plane_user_id, github_user_id, github_login required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        user = get_object_or_404(User, pk=plane_user_id)

        cred = WorkspaceCredential.objects.filter(workspace=ws, source="github").first()
        if not cred:
            return Response(
                {"detail": "GitHub workspace not connected; install workspace-level first"},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Reject if this github_user_id is already mapped to a different
        # Plane user in this workspace — actor attribution downstream
        # keys off github_user_id, so duplicate mappings would silently
        # misattribute.
        clash = (
            WorkspaceUserConnection.objects.filter(
                workspace=ws,
                connection_type="github",
                connection_id=str(github_user_id),
            )
            .exclude(user=user)
            .first()
        )
        if clash:
            return Response(
                {"detail": "github_user_id already linked to another Plane user in this workspace"},
                status=status.HTTP_409_CONFLICT,
            )

        user_conn_defaults = {
            "credential": cred,
            "connection_id": str(github_user_id),
            "connection_slug": github_login,
            "connection_data": {
                "github_login": github_login,
                "github_email": github_email,
            },
            "scopes": [],
            "config": {},
            "deleted_at": None,
        }

        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(user)
        request.user = user
        try:
            with transaction.atomic():
                conn = WorkspaceUserConnection.objects.filter(
                    workspace=ws, user=user, connection_type="github"
                ).first()
                if not conn:
                    conn = (
                        WorkspaceUserConnection.all_objects.filter(
                            workspace=ws, user=user, connection_type="github"
                        )
                        .order_by("-deleted_at")
                        .first()
                    )
                if conn:
                    created = False
                    for k, v in user_conn_defaults.items():
                        setattr(conn, k, v)
                    conn.save()
                else:
                    created = True
                    conn = WorkspaceUserConnection.objects.create(
                        workspace=ws, user=user, connection_type="github", **user_conn_defaults
                    )
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user

        return Response(
            {"id": str(conn.id), "created": created},
            status=status.HTTP_200_OK,
        )


class SiloGithubInstallBelongsEndpoint(BaseAPIView):
    """Confirm a (workspace_slug, installation_id) pair is a real
    workspace install. Used by silo before serving repo lists, so a
    client that knows a workspace slug can't probe arbitrary
    installation_ids and read someone else's repos.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        slug = data.get("workspace_slug")
        installation_id = data.get("installation_id")
        if not (slug and installation_id):
            return Response(
                {"detail": "workspace_slug and installation_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ws = Workspace.objects.filter(slug=slug, deleted_at__isnull=True).first()
        if not ws:
            return Response({"ok": False})
        exists = WorkspaceConnection.objects.filter(
            workspace=ws,
            connection_type="github",
            connection_id=str(installation_id),
            deleted_at__isnull=True,
        ).exists()
        return Response({"ok": exists})


class SiloGithubRepoBindingsEndpoint(BaseAPIView):
    """Look up project↔repo bindings for an inbound GitHub webhook.

    A raw webhook payload tells us `installation.id` + `repository.id`
    (or `repository.full_name`) but no workspace slug. This endpoint
    answers: "given this install + this repo, which Plane workspace +
    project bindings should mirror events into?"

    Returns one row per `WorkspaceEntityConnection(type='github-repo')`
    matching the install and repo (a single repo can be bound to
    multiple projects, even across workspaces if two workspaces
    happen to install on the same org).
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        installation_id = data.get("installation_id")
        repo_id = data.get("repo_id")
        repo_full_name = data.get("repo_full_name")
        workspace_slug = data.get("workspace_slug")
        project_id = data.get("project_id")

        # Two lookup modes:
        #   inbound webhook  → (installation_id, repo_id|repo_full_name)
        #   outbound mirror  → (workspace_slug, project_id)
        # Outbound starts from a Plane work item event and needs to
        # find which github-repo bindings on that project should
        # receive mirrored writes.
        if not (installation_id or (workspace_slug and project_id)):
            return Response(
                {"detail": (
                    "(installation_id + repo_id|repo_full_name) or "
                    "(workspace_slug + project_id) required"
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )

        connections_qs = WorkspaceConnection.objects.filter(
            connection_type="github",
            deleted_at__isnull=True,
            credential__deleted_at__isnull=True,
        ).select_related("workspace")
        if installation_id:
            connections_qs = connections_qs.filter(connection_id=str(installation_id))
        if workspace_slug:
            connections_qs = connections_qs.filter(workspace__slug=workspace_slug)
        connections = connections_qs
        if not connections.exists():
            return Response({"bindings": []})

        qs = WorkspaceEntityConnection.objects.filter(
            workspace_connection__in=connections,
            type="github-repo",
            deleted_at__isnull=True,
            workspace_connection__deleted_at__isnull=True,
        ).select_related("workspace_connection", "workspace_connection__workspace")
        if repo_id:
            qs = qs.filter(entity_id=str(repo_id))
        elif repo_full_name:
            qs = qs.filter(entity_slug=repo_full_name)
        if project_id:
            qs = qs.filter(project_id=project_id)

        out = []
        for m in qs:
            wc = m.workspace_connection
            # Phase 4g: GHES installs persist the customer's web origin
            # in connection_data so silo can swap api.github.com on a
            # per-install basis. Empty/None on cloud installs.
            ghes_base_url = (wc.connection_data or {}).get("ghes_base_url") or None
            out.append(
                {
                    "id": str(m.id),
                    "workspace_id": str(wc.workspace_id),
                    "workspace_slug": wc.workspace.slug,
                    "workspace_connection_id": str(wc.id),
                    "installation_id": wc.connection_id,
                    "ghes_base_url": ghes_base_url,
                    "project_id": str(m.project_id) if m.project_id else None,
                    "entity_id": m.entity_id,
                    "entity_slug": m.entity_slug,
                    "config": m.config or {},
                }
            )
        return Response({"bindings": out})


class SiloGithubPrStateMapEndpoint(BaseAPIView):
    """Resolve the PR-lifecycle → Plane state_id map for a project.

    Phase 4f. The 6-key map (`draft`, `opened`, `review_requested`,
    `approved`, `merged`, `closed_without_merge`) is stored as a
    `WorkspaceEntityConnection(type='github-pr-state-map', ...)` row.
    Two scopes:
      - workspace default: `project_id IS NULL`
      - per-project override: `project_id=<pid>`

    Resolution rule: per-project overrides win key-by-key over the
    workspace default. Missing keys are simply absent from the
    response — silo treats absent keys as "leave Plane state alone"
    for that PR transition.

    Lookup mode: silo passes either (installation_id, repo_id) or
    (workspace_slug, project_id). The first comes from a raw
    pull_request webhook payload and resolves the project via the
    matching `github-repo` binding. We accept both because the
    pull_request handler doesn't always know the workspace slug
    until after the binding lookup.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        workspace_slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        installation_id = data.get("installation_id")
        repo_id = data.get("repo_id")
        repo_full_name = data.get("repo_full_name")

        if not (
            (workspace_slug and project_id)
            or (installation_id and (repo_id or repo_full_name))
        ):
            return Response(
                {"detail": (
                    "(workspace_slug + project_id) or "
                    "(installation_id + repo_id|repo_full_name) required"
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # If only the install+repo were given, find the project via the
        # github-repo binding (same row pull_request lookups already use).
        if not (workspace_slug and project_id):
            qs = WorkspaceEntityConnection.objects.filter(
                workspace_connection__connection_type="github",
                workspace_connection__connection_id=str(installation_id),
                workspace_connection__deleted_at__isnull=True,
                type="github-repo",
                deleted_at__isnull=True,
            ).select_related("workspace_connection__workspace")
            if repo_id:
                qs = qs.filter(entity_id=str(repo_id))
            else:
                qs = qs.filter(entity_slug=repo_full_name)
            binding = qs.first()
            if not binding or not binding.project_id:
                return Response({"map": {}, "scope": None})
            workspace = binding.workspace_connection.workspace
            project_id = str(binding.project_id)
        else:
            workspace = get_object_or_404(Workspace, slug=workspace_slug)

        rows = list(
            WorkspaceEntityConnection.objects.filter(
                workspace=workspace,
                type="github-pr-state-map",
                deleted_at__isnull=True,
            ).values("project_id", "config")
        )
        # Workspace default first, per-project override layered on top.
        merged: dict = {}
        for r in rows:
            if r["project_id"] is None:
                merged.update((r.get("config") or {}).get("prStateMap") or {})
        for r in rows:
            if str(r["project_id"]) == str(project_id):
                merged.update((r.get("config") or {}).get("prStateMap") or {})
        # Drop empty-string values — the FE writes "" when the user clears
        # a row, and silo's "absent ⇒ leave state alone" rule needs
        # absence, not the empty string.
        out = {k: v for k, v in merged.items() if v}
        scope = "project" if any(
            str(r["project_id"]) == str(project_id) for r in rows
        ) else ("workspace" if any(r["project_id"] is None for r in rows) else None)
        return Response({"map": out, "scope": scope, "project_id": str(project_id)})


class SiloGithubIssueLinkEndpoint(BaseAPIView):
    """Persist (or look up) the link between a GitHub Issue and a
    Plane work item. Stored as a
    `WorkspaceEntityConnection(type='github-issue-link')` row scoped
    to the same workspace_connection as the repo binding.

    POST creates-or-returns the link. GET-style lookups (by gh issue
    id) hit `/silo/github/issue-link/lookup/` instead so this endpoint
    stays write-only.

    Body:
      workspace_connection_id, project_id, gh_issue_id (str),
      gh_issue_number (int, for backlink rendering),
      gh_repo_full_name, plane_issue_id, plane_project_id.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        wc_id = data.get("workspace_connection_id")
        project_id = data.get("project_id")
        gh_issue_id = data.get("gh_issue_id")
        gh_issue_number = data.get("gh_issue_number")
        gh_repo_full_name = data.get("gh_repo_full_name") or ""
        plane_issue_id = data.get("plane_issue_id")
        plane_project_id = data.get("plane_project_id")
        gh_comment_map = data.get("gh_comment_map")
        plane_comment_map = data.get("plane_comment_map")
        if not (wc_id and project_id and gh_issue_id and plane_issue_id and plane_project_id):
            return Response(
                {"detail": (
                    "workspace_connection_id, project_id, gh_issue_id, "
                    "plane_issue_id, plane_project_id required"
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )

        wc = get_object_or_404(WorkspaceConnection, pk=wc_id, deleted_at__isnull=True)
        # Verify the Plane project + work item actually live in this
        # connection's workspace before linking. Defense-in-depth: the
        # HMAC channel is trusted, but this stops a silo-side mixup from
        # linking a GH issue to another workspace's work item.

        if not Project.objects.filter(
            pk=project_id, workspace=wc.workspace
        ).exists():
            return Response(
                {"detail": "project_id does not belong to this connection's workspace"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not Issue.objects.filter(
            pk=plane_issue_id, workspace=wc.workspace, project_id=project_id
        ).exists():
            return Response(
                {"detail": "plane_issue_id does not belong to project_id in this workspace"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Preserve any existing `entity_data` keys (notably
        # `gh_comment_map`) by merging instead of replacing. The
        # comment map grows over the issue's lifetime as comments
        # are mirrored — caller passes the merged map when it has
        # one, otherwise we leave whatever was already there.
        existing = WorkspaceEntityConnection.objects.filter(
            workspace_connection=wc,
            type="github-issue-link",
            entity_type="issue",
            entity_id=str(gh_issue_id),
        ).first()
        merged_entity_data = dict((existing.entity_data or {}) if existing else {})
        merged_entity_data["gh_issue_number"] = gh_issue_number
        merged_entity_data["gh_repo_full_name"] = gh_repo_full_name
        if gh_comment_map is not None and isinstance(gh_comment_map, dict):
            merged_entity_data["gh_comment_map"] = gh_comment_map
        if plane_comment_map is not None and isinstance(plane_comment_map, dict):
            merged_entity_data["plane_comment_map"] = plane_comment_map

        link, _created = WorkspaceEntityConnection.objects.update_or_create(
            workspace=wc.workspace,
            workspace_connection=wc,
            type="github-issue-link",
            entity_type="issue",
            entity_id=str(gh_issue_id),
            defaults={
                "project_id": project_id,
                "issue_id": plane_issue_id,
                "entity_slug": gh_repo_full_name,
                "entity_data": merged_entity_data,
                "config": {"plane_project_id": plane_project_id},
            },
        )
        return Response(
            {
                "id": str(link.id),
                "plane_issue_id": str(link.issue_id) if link.issue_id else None,
                "plane_project_id": str(link.project_id) if link.project_id else None,
            }
        )


class SiloGithubIssueLinkLookupEndpoint(BaseAPIView):
    """Find an existing `github-issue-link` row by gh_issue_id (and
    optionally workspace_connection_id) so silo can short-circuit
    duplicate-create on retried webhook deliveries and look up the
    Plane work item to PATCH on edit/close events.

    Returns 404 if no link exists.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        gh_issue_id = data.get("gh_issue_id")
        plane_issue_id = data.get("plane_issue_id")
        wc_id = data.get("workspace_connection_id")
        if not (gh_issue_id or plane_issue_id):
            return Response(
                {"detail": "gh_issue_id or plane_issue_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        qs = WorkspaceEntityConnection.objects.filter(
            type="github-issue-link",
            entity_type="issue",
            deleted_at__isnull=True,
        )
        if gh_issue_id:
            qs = qs.filter(entity_id=str(gh_issue_id))
        if plane_issue_id:
            qs = qs.filter(issue_id=plane_issue_id)
        if wc_id:
            qs = qs.filter(workspace_connection_id=wc_id)
        link = qs.first()
        if not link:
            return Response({"detail": "not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {
                "id": str(link.id),
                "workspace_connection_id": str(link.workspace_connection_id),
                "project_id": str(link.project_id) if link.project_id else None,
                "plane_issue_id": str(link.issue_id) if link.issue_id else None,
                "entity_id": link.entity_id,
                "entity_slug": link.entity_slug,
                "entity_data": link.entity_data or {},
            }
        )


class SiloUpdateWorkItemEndpoint(BaseAPIView):
    """PATCH a Plane work item from a mirrored source (GitHub Issue
    edit / close / reopen / assignee change). Resolves actor from
    `gh_user_login` via `WorkspaceUserConnection(connection_slug=...)`
    when set; falls back to the workspace install's installer.

    Accepts a partial payload — any of: name, description, state_id,
    assignee_ids, label_ids. Unspecified fields untouched.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        issue_id = data.get("issue_id")
        gh_user_login = data.get("gh_user_login")
        actor_id = data.get("actor_user_id")
        if not (slug and project_id and issue_id):
            return Response(
                {"detail": "workspace_slug, project_id, issue_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)
        issue = get_object_or_404(Issue, pk=issue_id, project=project)

        actor = None
        if actor_id:
            actor = User.objects.filter(pk=actor_id).first()
        if not actor and gh_user_login:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="github",
                    connection_slug=gh_user_login,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor:
            cred = WorkspaceCredential.objects.filter(workspace=ws, source="github").first()
            if cred:
                actor = cred.user
        if not actor:
            return Response(
                {"detail": "could not resolve actor"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Apply scalar field updates via instance.save() (NOT queryset
        # .update()) so BaseModel.save's hooks run — notably
        # _sync_completed_at, which stamps/clears completed_at when the
        # state group changes. A bare .update() skips that and leaves
        # completed_at wrong on a GH-driven close/reopen.
        #
        # BaseModel.save reads the actor via crum's get_current_user;
        # the silo HMAC principal is anonymous, so set the thread-local
        # to `actor` and reset in `finally` to avoid leaking crum state
        # into another request on the same worker.
        # Snapshot the pre-update values so the activity tracker can diff
        # them (track_state dereferences current_instance — passing None
        # makes it crash, which the try/except below would silently
        # swallow, losing the state-change activity row). Capturing name
        # + description_html too lets the activity log record the real
        # old_value instead of None on title/body edits.
        prev_state_id = str(issue.state_id) if issue.state_id else None
        prev_name = issue.name
        prev_description_html = issue.description_html
        # Pre-update assignee/label ids: fed to the activity tracker as
        # old_value AND reused as the "existing" set for the M2M diff
        # below (so we don't re-query). track_assignees / track_labels
        # read these from current_instance.
        prev_assignee_ids = [
            str(x) for x in IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)
        ]
        prev_label_ids = [
            str(x) for x in IssueLabel.objects.filter(issue=issue).values_list("label_id", flat=True)
        ]

        updates = {}
        if "name" in data and data["name"] is not None:
            updates["name"] = str(data["name"])[:255]
        if "description_html" in data and data["description_html"] is not None:
            updates["description_html"] = str(data["description_html"])
        # Only treat state as changed when it actually differs. issue.save
        # → _sync_completed_at keys off has_changed("state_id"), which can
        # read True from a string-vs-UUID mismatch even when the value is
        # the same — that would clobber a historical completed_at with
        # now() on a title-only edit. Compare as strings to avoid it.
        if "state_id" in data and data["state_id"] and str(data["state_id"]) != (prev_state_id or ""):
            # Validate the target state exists AND belongs to this project
            # before applying — an unvalidated state_id could 500 on a
            # malformed UUID or cross project boundaries with a foreign
            # state. The ValidationError guard covers the malformed case
            # (.filter(pk=<bad-uuid>) raises rather than returning empty).
            try:
                state_ok = State.objects.filter(pk=data["state_id"], project=project).exists()
            except (ValidationError, ValueError):
                state_ok = False
            if not state_ok:
                return Response(
                    {"detail": "state_id is not valid for this project"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            updates["state_id"] = data["state_id"]

        if updates:
            for field, value in updates.items():
                setattr(issue, field, value)
            prev_user = get_current_user()
            prev_request_user = request.user
            set_current_user(actor)
            request.user = actor
            try:
                # update_fields keeps the write tight; _sync_completed_at
                # adds completed_at to the set when state changes. Map the
                # `state_id` attname to the `state` field name — this
                # Django version accepts either, but `state` is the
                # canonical field name and avoids any version-dependent
                # update_fields validation surprises.
                update_fields = [("state" if f == "state_id" else f) for f in updates]
                issue.save(update_fields=update_fields)
            finally:
                set_current_user(prev_user)
                request.user = prev_request_user

        # Assignees + labels are M2M; replace the full set if provided.
        if "assignee_ids" in data and isinstance(data["assignee_ids"], list):
            new_ids = {str(x) for x in data["assignee_ids"]}
            existing = set(prev_assignee_ids)
            to_add = new_ids - existing
            to_remove = existing - new_ids
            for uid in to_add:
                IssueAssignee.objects.create(
                    assignee_id=uid,
                    issue=issue,
                    project_id=project.id,
                    workspace_id=ws.id,
                    created_by_id=actor.id,
                    updated_by_id=actor.id,
                )
            if to_remove:
                IssueAssignee.objects.filter(issue=issue, assignee_id__in=to_remove).delete()

        if "label_ids" in data and isinstance(data["label_ids"], list):
            new_ids = {str(x) for x in data["label_ids"]}
            existing = set(prev_label_ids)
            to_add = new_ids - existing
            to_remove = existing - new_ids
            for lid in to_add:
                IssueLabel.objects.create(
                    label_id=lid,
                    issue=issue,
                    project_id=project.id,
                    workspace_id=ws.id,
                    created_by_id=actor.id,
                    updated_by_id=actor.id,
                )
            if to_remove:
                IssueLabel.objects.filter(issue=issue, label_id__in=to_remove).delete()

        # Mirror the activity hook so notification fan-out runs. Both the
        # requested (new) and current_instance (old) payloads must carry
        # every changed field — track_assignees / track_labels read
        # assignee_ids / label_ids from BOTH, so omitting them on either
        # side drops the activity row (labels) or logs an empty old_value
        # (assignees).
        try:
            requested = {k: v for k, v in updates.items()}
            current_inst = {
                "state_id": prev_state_id,
                "name": prev_name,
                "description_html": prev_description_html,
            }
            if "assignee_ids" in data and isinstance(data["assignee_ids"], list):
                requested["assignee_ids"] = [str(x) for x in data["assignee_ids"]]
                current_inst["assignee_ids"] = prev_assignee_ids
            if "label_ids" in data and isinstance(data["label_ids"], list):
                requested["label_ids"] = [str(x) for x in data["label_ids"]]
                current_inst["label_ids"] = prev_label_ids
            issue_activity.delay(
                type="issue.activity.updated",
                requested_data=_json.dumps(requested),
                actor_id=str(actor.id),
                issue_id=str(issue.id),
                project_id=str(project.id),
                # Pre-update snapshot so the trackers diff against the
                # real old values instead of dereferencing None / logging
                # None as old_value.
                current_instance=_json.dumps(current_inst),
                epoch=int(_tz.now().timestamp()),
                notification=True,
            )
        except Exception:
            pass

        return Response({"id": str(issue.id), "updated": True})


class SiloUpdateCommentEndpoint(BaseAPIView):
    """PATCH or DELETE an IssueComment by id. Used to mirror edits /
    deletions from GitHub issue comments. Idempotent on missing rows
    (returns 200 with deleted=true) so a webhook retry on a deleted
    comment doesn't 5xx silo.

    Body: {comment_id, action: "edit"|"delete", comment_html?,
           workspace_slug, issue_id}

    `workspace_slug` + `issue_id` scope the lookup: the comment must
    belong to that work item in that workspace. Defense-in-depth — the
    HMAC channel is already trusted, but this stops a silo-side bug
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        comment_id = data.get("comment_id")
        action = data.get("action")
        workspace_slug = data.get("workspace_slug")
        issue_id = data.get("issue_id")
        if not (comment_id and action in {"edit", "delete"}):
            return Response(
                {"detail": "comment_id and action in (edit, delete) required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not (workspace_slug and issue_id):
            return Response(
                {"detail": "workspace_slug and issue_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Scope the lookup to the claimed workspace + work item so a
        # bad comment_id can't reach across to another workspace's data.
        comment = IssueComment.objects.filter(
            pk=comment_id,
            issue_id=issue_id,
            workspace__slug=workspace_slug,
        ).first()
        if not comment:
            return Response({"id": str(comment_id), "missing": True})
        if action == "delete":
            comment.delete()
            return Response({"id": str(comment_id), "deleted": True})
        comment_html = data.get("comment_html") or ""
        IssueComment.objects.filter(pk=comment.pk).update(comment_html=comment_html)
        return Response({"id": str(comment_id), "updated": True})


class SiloGithubInstallLifecycleEndpoint(BaseAPIView):
    """Reflect GitHub install lifecycle events into Plane state.

    Accepts: {action: "uninstalled" | "repos_changed" | "repo_renamed"
              | "repo_archived" | "repo_deleted",
              installation_id, ...}.

    - uninstalled: soft-delete every WorkspaceConnection for this
      install (one per workspace if multiple share the org), plus
      cascade-soft-delete their `github-repo` and
      `github-issue-link` entity connections.
    - repos_changed: merge the added/removed repo deltas into
      `connection_data.repositories` for all matching workspace
      connections (the webhook only carries the delta, not the full
      selection).
    - repo_renamed: update `entity_slug` on `github-repo` rows
      (entity_id stays the same).
    - repo_archived / repo_deleted: soft-delete `github-repo` rows
      for that repo across all matching connections.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        action = data.get("action")
        installation_id = data.get("installation_id")
        if not (action and installation_id):
            return Response(
                {"detail": "action and installation_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        connections = WorkspaceConnection.objects.filter(
            connection_type="github",
            connection_id=str(installation_id),
            deleted_at__isnull=True,
        )

        if action == "uninstalled":
            now = _tz.now()
            for wc in connections:
                # Soft-delete via .update() to bypass crum (silo
                # principal is anonymous) and avoid recursive on_save.
                WorkspaceEntityConnection.objects.filter(
                    workspace_connection=wc, deleted_at__isnull=True
                ).update(deleted_at=now)
                WorkspaceConnection.objects.filter(pk=wc.pk).update(deleted_at=now)
            return Response({"deleted": connections.count()})

        if action == "repos_changed":
            # `installation_repositories` carries only the delta, so we
            # merge into the cached list instead of replacing it — a
            # wholesale replace would drop every previously-selected
            # repo on the first add/remove. Legacy callers that still
            # send a full `repositories` list keep working.
            added = data.get("repositories_added") or []
            removed = data.get("repositories_removed") or []
            legacy_full = data.get("repositories")
            removed_ids = {str(r.get("id")) for r in removed}
            added_ids = {str(r.get("id")) for r in added}
            for wc in connections:
                cd = dict(wc.connection_data or {})
                if legacy_full is not None and not (added or removed):
                    cd["repositories"] = legacy_full
                else:
                    current = list(cd.get("repositories") or [])
                    # Drop anything removed or about to be re-added
                    # (dedupe by id), then append the current adds.
                    kept = [
                        r
                        for r in current
                        if str(r.get("id")) not in removed_ids
                        and str(r.get("id")) not in added_ids
                    ]
                    cd["repositories"] = kept + [
                        {"id": str(r.get("id")), "full_name": r.get("full_name")}
                        for r in added
                    ]
                WorkspaceConnection.objects.filter(pk=wc.pk).update(connection_data=cd)
            return Response({"updated": connections.count()})

        if action == "repo_renamed":
            old = data.get("repo_full_name_old")
            new = data.get("repo_full_name_new")
            repo_id = data.get("repo_id")
            if not (repo_id and new):
                return Response(
                    {"detail": "repo_id and repo_full_name_new required"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            qs = WorkspaceEntityConnection.objects.filter(
                workspace_connection__in=connections,
                type="github-repo",
                entity_id=str(repo_id),
                deleted_at__isnull=True,
            )
            if old:
                qs = qs.filter(entity_slug=old)
            updated = qs.update(entity_slug=new)
            return Response({"updated": updated})

        if action in {"repo_archived", "repo_deleted"}:
            repo_id = data.get("repo_id")
            if not repo_id:
                return Response(
                    {"detail": "repo_id required"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            now = _tz.now()
            # Soft-delete the github-repo bindings for this repo across
            # all matching connections. github-issue-link rows are left
            # alone — without them in place, future webhook hits on the
            # archived repo won't find a binding to mirror through (fail
            # closed), but historical links to existing Plane work items
            # stay queryable.
            n_repo = WorkspaceEntityConnection.objects.filter(
                workspace_connection__in=connections,
                type="github-repo",
                entity_id=str(repo_id),
                deleted_at__isnull=True,
            ).update(deleted_at=now)
            return Response({"deleted": n_repo})

        return Response({"detail": f"unknown action: {action}"}, status=status.HTTP_400_BAD_REQUEST)


class SiloSlackTeamContextEndpoint(BaseAPIView):
    """Resolve a Slack team_id to the Plane workspace and projects.

    Silo calls this when handling slash commands / interactivity to
    open a modal. Returns the bot token (so silo can call Slack APIs)
    plus the project list (so the modal can show a project picker).

    Tokens are HMAC-gated to silo only and never leave the server-to-
    server channel.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        team_id = (request.data or {}).get("team_id")
        if not team_id:
            return Response(
                {"detail": "team_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Skip soft-deleted connections (and connections whose credential
        # was soft-deleted out from under them) so silo never resolves
        # context for an integration that's been removed.
        conn = (
            WorkspaceConnection.objects.select_related("workspace", "credential")
            .filter(
                connection_type="slack",
                connection_id=team_id,
                deleted_at__isnull=True,
                credential__deleted_at__isnull=True,
                workspace__deleted_at__isnull=True,
            )
            .first()
        )
        if not conn:
            return Response(
                {"detail": "no Slack connection for that team_id"},
                status=status.HTTP_404_NOT_FOUND,
            )

        ws = conn.workspace
        projects = list(
            Project.objects.filter(workspace=ws)
            .order_by("name")
            .values("id", "name", "identifier")
        )
        return Response(
            {
                "workspace_id": str(ws.id),
                "workspace_slug": ws.slug,
                "workspace_name": ws.name,
                "bot_token": conn.credential.source_access_token if conn.credential else None,
                "refresh_token": conn.credential.source_refresh_token if conn.credential else None,
                "token_expires_at": (
                    conn.credential.source_token_expires_at.isoformat()
                    if conn.credential and conn.credential.source_token_expires_at
                    else None
                ),
                "bot_user_id": (conn.connection_data or {}).get("bot_user_id", ""),
                "installer_user_id": (
                    str(conn.credential.user_id) if conn.credential and conn.credential.user_id else None
                ),
                "projects": [
                    {"id": str(p["id"]), "name": p["name"], "identifier": p["identifier"]}
                    for p in projects
                ],
            }
        )


class SiloSlackPersistTokensEndpoint(BaseAPIView):
    """Persist a refreshed Slack bot token pair from silo.

    Silo handles the `oauth.v2.access` refresh call (it owns the
    Slack client_secret), then sends the new pair here for storage.
    Idempotent on (workspace, source='slack', source_identifier=team_id).
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        team_id = data.get("team_id")
        access_token = data.get("access_token")
        refresh_token = data.get("refresh_token") or ""
        expires_in = data.get("expires_in")

        if not (team_id and access_token):
            return Response(
                {"detail": "team_id and access_token required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The same Slack team can be installed in multiple Plane
        # workspaces. Update every live credential row for this team
        # so rotation doesn't leave other workspaces with a stale token.
        creds = WorkspaceCredential.objects.filter(
            source="slack",
            source_identifier=team_id,
            deleted_at__isnull=True,
        )
        if not creds.exists():
            return Response(
                {"detail": "no Slack credential for that team_id"},
                status=status.HTTP_404_NOT_FOUND,
            )

        update_fields: dict = {
            "source_access_token": access_token,
            "updated_at": timezone.now(),
        }
        if refresh_token:
            update_fields["source_refresh_token"] = refresh_token
        if expires_in is not None:
            try:
                expires_in_val = int(expires_in)
                if expires_in_val > 0:
                    update_fields["source_token_expires_at"] = timezone.now() + timedelta(seconds=expires_in_val)
            except (ValueError, TypeError):
                pass
        creds.update(**update_fields)
        return Response({"ok": True}, status=status.HTTP_200_OK)


class SiloSlackUserConnectEndpoint(BaseAPIView):
    """Persist a per-user Slack ↔ Plane mapping completed by silo.

    Silo handles the user-scope OAuth dance and posts the resulting
    Slack user_id here for storage. The mapping is keyed on
    (workspace, user, connection_type='slack'). We do NOT store the
    user-scope access token — silo never needs to call Slack as the
    user; the binding is purely for attribution (Slack user_id ->
    Plane user when creating work items, mirroring comments, etc.).
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        plane_user_id = data.get("plane_user_id")
        slack_team_id = data.get("slack_team_id")
        slack_user_id = data.get("slack_user_id")
        slack_user_email = data.get("slack_user_email") or ""

        if not (slug and plane_user_id and slack_team_id and slack_user_id):
            return Response(
                {"detail": "workspace_slug, plane_user_id, slack_team_id, slack_user_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        user = get_object_or_404(User, pk=plane_user_id)

        # Reuse the workspace-level Slack credential — there is no
        # per-user token to keep separate.
        cred = (
            WorkspaceCredential.objects.filter(
                workspace=ws, source="slack", source_identifier=slack_team_id
            )
            .first()
        )
        if not cred:
            return Response(
                {"detail": "Slack workspace not connected; install workspace-level first"},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Reconnect path: restore the prior soft-deleted row when one
        # exists, but never call update_or_create on `all_objects` —
        # the unique constraint is conditional on deleted_at IS NULL,
        # so multiple soft-deleted rows can exist and collide.
        user_conn_defaults = {
            "credential": cred,
            "connection_id": slack_user_id,
            "connection_data": {
                "slack_team_id": slack_team_id,
                "slack_user_email": slack_user_email,
            },
            "scopes": [],
            "config": {},
            "deleted_at": None,
        }
        # Reject if this slack_user_id is already mapped to a different
        # Plane user in this workspace — actor attribution downstream
        # (SiloCreate{Comment,WorkItem}Endpoint) keys off slack_user_id,
        # so duplicate mappings would silently misattribute.
        clash = (
            WorkspaceUserConnection.objects.filter(
                workspace=ws,
                connection_type="slack",
                connection_id=slack_user_id,
            )
            .exclude(user=user)
            .first()
        )
        if clash:
            return Response(
                {"detail": "slack_user_id already linked to another Plane user in this workspace"},
                status=status.HTTP_409_CONFLICT,
            )

        # Set crum + request.user to `user` so audit columns and signals
        # see the actual Plane user instead of the anonymous silo principal.
        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(user)
        request.user = user
        try:
            conn = WorkspaceUserConnection.objects.filter(
                workspace=ws, user=user, connection_type="slack"
            ).first()
            if not conn:
                conn = (
                    WorkspaceUserConnection.all_objects.filter(
                        workspace=ws, user=user, connection_type="slack"
                    )
                    .order_by("-deleted_at")
                    .first()
                )
            if conn:
                created = False
                for k, v in user_conn_defaults.items():
                    setattr(conn, k, v)
                conn.save()
            else:
                created = True
                conn = WorkspaceUserConnection.objects.create(
                    workspace=ws, user=user, connection_type="slack", **user_conn_defaults
                )
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user
        return Response(
            {"id": str(conn.id), "created": created},
            status=status.HTTP_200_OK,
        )


class SiloCreateCommentEndpoint(BaseAPIView):
    """Create an IssueComment on behalf of silo (e.g. Slack Reply button).

    Same actor-resolution rules as SiloCreateWorkItemEndpoint:
    explicit actor_user_id → slack_user_id mapping → installer fallback.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        issue_id = data.get("issue_id")
        comment_html = (data.get("comment_html") or "").strip()
        actor_id = data.get("actor_user_id")
        slack_user_id = data.get("slack_user_id")
        slack_team_id = data.get("slack_team_id")
        gh_user_login = data.get("gh_user_login")

        if not (slug and project_id and issue_id and comment_html):
            return Response(
                {"detail": "workspace_slug, project_id, issue_id, comment_html required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)
        issue = get_object_or_404(Issue, pk=issue_id, project=project)

        # Same actor resolution as create-work-item.
        actor = None
        if actor_id:
            actor = User.objects.filter(pk=actor_id).first()
        if not actor and slack_user_id:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="slack",
                    connection_id=slack_user_id,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor and slack_team_id:
            cred = WorkspaceCredential.objects.filter(
                workspace=ws, source="slack", source_identifier=slack_team_id
            ).first()
            if cred:
                actor = cred.user
        if not actor and gh_user_login:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="github",
                    connection_slug=gh_user_login,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor:
            cred = WorkspaceCredential.objects.filter(workspace=ws, source="github").first()
            if cred:
                actor = cred.user
        if not actor:
            return Response(
                {"detail": "could not resolve actor"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Go through IssueCommentSerializer so comment_html is sanitized
        # and comment_json (Lexical editor format) is populated — the FE
        # comment renderer reads comment_json, so a direct ORM create
        # would render as an empty bubble.
        serializer = IssueCommentSerializer(
            data={"comment_html": comment_html},
            context={"request": request},
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # BaseModel.save reads the actor via crum's get_current_user. The
        # silo HMAC principal is anonymous, so without overriding the
        # thread-local user we'd land created_by=None and any on_save
        # signals would run with the wrong actor. Reset in `finally` so
        # we never leak crum state into another request on the same worker.
        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(actor)
        request.user = actor
        try:
            comment = serializer.save(
                project_id=project.id,
                issue_id=issue.id,
                workspace_id=ws.id,
                actor=actor,
            )
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user

        # Fire activity so silo notification fan-out runs.

        try:
            issue_activity.delay(
                type="comment.activity.created",
                requested_data=_json.dumps({"comment_html": comment_html}),
                actor_id=str(actor.id),
                issue_id=str(issue.id),
                project_id=str(project.id),
                current_instance=_json.dumps({"id": str(comment.id)}),
                epoch=int(_tz.now().timestamp()),
            )
        except Exception:
            pass

        return Response(
            {"id": str(comment.id)},
            status=status.HTTP_201_CREATED,
        )


class SiloProjectMappingsEndpoint(BaseAPIView):
    """List entity-connection mappings for a project (silo-internal).

    Mirrors `WorkspaceEntityConnectionListCreateEndpoint`'s GET but
    over the silo HMAC channel — used by silo when fanning out
    work-item events to bound channels. Filters by project_id +
    type (e.g. 'slack-channel-notification').
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):
        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        mapping_type = data.get("type")

        if not slug:
            return Response(
                {"detail": "workspace_slug required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Filter out soft-deleted entity connections, plus mappings whose
        # parent workspace_connection or its credential were soft-deleted —
        # otherwise silo would keep fanning out events to dead integrations.
        # project_id is optional: silo's DM-target path needs to discover
        # a workspace's Slack team_id even when no channel mapping exists
        # for the project, so we expose all live workspace mappings when
        # project_id is omitted.
        ws = get_object_or_404(Workspace, slug=slug)
        qs = WorkspaceEntityConnection.objects.filter(
            workspace=ws,
            deleted_at__isnull=True,
            workspace_connection__deleted_at__isnull=True,
            workspace_connection__credential__deleted_at__isnull=True,
        )
        if project_id:
            qs = qs.filter(project_id=project_id)
        if mapping_type:
            qs = qs.filter(type=mapping_type)

        # Also fetch the workspace_connection for slack-channel mappings
        # so silo gets the team_id without a second roundtrip.
        out = []
        for m in qs.select_related("workspace_connection"):
            wc = m.workspace_connection
            out.append(
                {
                    "id": str(m.id),
                    "workspace_connection_id": str(wc.id),
                    "connection_type": wc.connection_type,
                    "connection_team_id": wc.connection_id,
                    "project_id": str(m.project_id) if m.project_id else None,
                    "type": m.type,
                    "entity_type": m.entity_type,
                    "entity_id": m.entity_id,
                    "entity_slug": m.entity_slug,
                    "config": m.config or {},
                }
            )
        return Response({"mappings": out})


class SiloWorkItemLookupEndpoint(BaseAPIView):
    """Resolve a Plane work-item URL to its display fields.

    Used by silo's `link_shared` Events handler to build an unfurl
    card. Silo parses the URL on its side; we just take the parsed
    pieces and look up the issue.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        project_identifier = data.get("project_identifier")
        sequence_id = data.get("sequence_id")
        issue_id = data.get("issue_id")

        if not slug or (not project_id and not project_identifier) or (not sequence_id and not issue_id):
            return Response(
                {
                    "detail": (
                        "workspace_slug, one of project_id/project_identifier, "
                        "and one of sequence_id/issue_id required"
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        if project_identifier is not None and not isinstance(project_identifier, str):
            return Response(
                {"detail": "project_identifier must be a string"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if sequence_id and not issue_id:
            try:
                sequence_id = int(sequence_id)
            except (ValueError, TypeError):
                return Response(
                    {"detail": "sequence_id must be a valid integer"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        ws = get_object_or_404(Workspace, slug=slug)
        if project_id:
            project = get_object_or_404(Project, pk=project_id, workspace=ws)
        else:
            project = get_object_or_404(
                Project, identifier__iexact=project_identifier.strip(), workspace=ws
            )

        qs = Issue.objects.filter(workspace=ws, project=project)
        if issue_id:
            qs = qs.filter(pk=issue_id)
        else:
            qs = qs.filter(sequence_id=sequence_id)
        issue = qs.select_related("state").first()
        if not issue:
            return Response({"detail": "not found"}, status=status.HTTP_404_NOT_FOUND)

        return Response(
            {
                "id": str(issue.id),
                "sequence_id": issue.sequence_id,
                "name": issue.name,
                "project_identifier": project.identifier,
                "state_name": issue.state.name if issue.state_id else None,
                "state_group": issue.state.group if issue.state_id else None,
                "priority": issue.priority,
                "workspace_slug": slug,
                "project_id": str(project.id),
            }
        )


class SiloProjectMetadataEndpoint(BaseAPIView):
    """Return picker-fillable metadata for a project.

    Powers the Slack create-work-item modal pickers: states, labels,
    members, work-item types (project-scoped, sorted by their
    ProjectIssueType level), and the static priority list. Light read
    — no token data — so callers can hit it on every modal open.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        if not (slug and project_id):
            return Response(
                {"detail": "workspace_slug and project_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)

        states = list(
            State.objects.filter(workspace=ws, project=project)
            .order_by("sequence")
            .values("id", "name", "group", "color", "default")
        )
        default_state_id = next(
            (str(s["id"]) for s in states if s.get("default")), None
        )

        labels = list(
            Label.objects.filter(workspace=ws, project=project)
            .order_by("sort_order", "name")
            .values("id", "name", "color")
        )

        members_qs = (
            ProjectMember.objects.filter(project=project, is_active=True, member__isnull=False)
            .select_related("member")
            .order_by("member__display_name")
        )
        members = [
            {
                "id": str(m.member_id),
                "display_name": m.member.display_name or m.member.email,
            }
            for m in members_qs
        ]

        # Surface only the work-item types attached to this project,
        # in the order configured for the project (level on the join).
        type_rows = list(
            ProjectIssueType.objects.filter(project=project, issue_type__is_active=True)
            .select_related("issue_type")
            .order_by("level")
        )
        types = [
            {
                "id": str(r.issue_type_id),
                "name": r.issue_type.name,
                "is_default": r.is_default,
                "is_epic": r.issue_type.is_epic,
            }
            for r in type_rows
        ]
        default_type_id = next((t["id"] for t in types if t["is_default"]), None)

        priorities = [
            {"key": k, "label": v} for k, v in Issue.PRIORITY_CHOICES
        ]

        return Response(
            {
                "states": [
                    {
                        "id": str(s["id"]),
                        "name": s["name"],
                        "group": s["group"],
                        "color": s["color"],
                    }
                    for s in states
                ],
                "default_state_id": default_state_id,
                "labels": [
                    {"id": str(label["id"]), "name": label["name"], "color": label["color"]}
                    for label in labels
                ],
                "members": members,
                "default_assignee_id": (
                    str(project.default_assignee_id) if project.default_assignee_id else None
                ),
                "types": types,
                "default_type_id": default_type_id,
                "priorities": priorities,
                "intake_enabled": bool(project.intake_view),
            }
        )


class SiloCreateWorkItemEndpoint(BaseAPIView):
    """Create a Plane work item on behalf of silo.

    Used by the Slack `/plane` modal submit (and later GitHub label
    automation). Silo passes the workspace slug, project id, title,
    optional description, and the user-id to attribute the create to
    (resolved via the Slack user → Plane user mapping; falls back to
    the integration installer).
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        title = (data.get("title") or "").strip()
        description = data.get("description") or ""
        # Two callers, two formats:
        #   - Slack action submits → plain text in `description`,
        #     needs HTML-escape + <p> wrap so Plane's editor doesn't
        #     mis-parse user `<`, `>`, `&`.
        #   - GitHub issues handler → already-rendered HTML (from
        #     marked) in `description_html`. Pass through; the editor
        #     parses standard tags (h1-h6, p, ul, li, code, a).
        description_html = data.get("description_html")
        actor_id = data.get("actor_user_id")
        slack_user_id = data.get("slack_user_id")
        slack_team_id = data.get("slack_team_id")
        gh_user_login = data.get("gh_user_login")
        type_id = data.get("type_id") or None
        state_id = data.get("state_id") or None
        priority = data.get("priority") or None
        label_ids = data.get("label_ids") or []
        assignee_ids = data.get("assignee_ids") or []
        as_intake = bool(data.get("as_intake"))

        if not (slug and project_id and title):
            return Response(
                {"detail": "workspace_slug, project_id, title required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)

        if as_intake and not project.intake_view:
            return Response(
                {"detail": "Intake is not enabled for this project"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Actor resolution priority:
        #   1. Explicit actor_user_id (caller-specified Plane user).
        #   2. Slack user_id → WorkspaceUserConnection → Plane user.
        #   3. Fall back to the integration installer
        #      (workspace-level credential's user).
        actor = None
        if actor_id:
            actor = User.objects.filter(pk=actor_id).first()
        if not actor and slack_user_id:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="slack",
                    connection_id=slack_user_id,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor and slack_team_id:
            cred = WorkspaceCredential.objects.filter(
                workspace=ws, source="slack", source_identifier=slack_team_id
            ).first()
            if cred:
                actor = cred.user
        if not actor and gh_user_login:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="github",
                    connection_slug=gh_user_login,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor:
            # GitHub mirror path: fall back to the workspace install's
            # installer when no per-user mapping exists. Lets a webhook
            # mirror an issue from an unmapped GH user without 400ing.
            cred = WorkspaceCredential.objects.filter(workspace=ws, source="github").first()
            if cred:
                actor = cred.user
        if not actor:
            return Response(
                {"detail": "could not resolve actor; provide actor_user_id or slack_user_id"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Escape so user-typed `<`, `>`, `&` don't get stripped or
        # mis-parsed by the editor's HTML sanitizer.
        if description_html:
            html_value = description_html
        elif description:
            html_value = f"<p>{_html.escape(description)}</p>"
        else:
            html_value = "<p></p>"
        payload = {
            "name": title[:255],
            "description_html": html_value,
        }
        if type_id:
            payload["type_id"] = type_id
        if priority:
            payload["priority"] = priority
        if label_ids:
            payload["labels"] = label_ids
        if assignee_ids:
            payload["assignees"] = assignee_ids

        # Intake submissions land in a triage state and are tracked via
        # IntakeIssue. Resolve (or create) the triage state up-front;
        # the api IssueSerializer's state validator excludes triage
        # states, so we don't pass it through the serializer — we
        # update issue.state after save.
        triage_state = None
        if as_intake:
            triage_state = State.triage_objects.filter(project_id=project.id, workspace=ws).first()
            if not triage_state:
                triage_state = State.objects.create(
                    name="Triage",
                    group=StateGroup.TRIAGE.value,
                    project_id=project.id,
                    workspace_id=ws.id,
                    color="#4E5355",
                    sequence=65000,
                    default=False,
                )
        elif state_id:
            payload["state"] = state_id

        serializer = IssueSerializer(
            data=payload,
            context={
                "request": request,
                "project_id": str(project.id),
                "workspace_id": str(ws.id),
                "default_assignee_id": project.default_assignee_id,
            },
        )
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # BaseModel.save reads the actor via crum's get_current_user. The
        # silo HMAC principal is anonymous, so without overriding the
        # thread-local user the initial save lands created_by=None and
        # any on_save signals run with the wrong actor. Set the thread-
        # local for the duration of the save and restore it after, so we
        # don't leak crum state into another request on the same worker.
        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(actor)
        request.user = actor
        try:
            serializer.save()
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user
        issue = serializer.instance

        # For intake submissions: park the issue in the triage state
        # (the api IssueSerializer rejects triage states via its state
        # validator, so we set it post-save) and create the IntakeIssue
        # row pointing at the project's default Intake.
        intake_issue = None
        if as_intake and triage_state is not None:
            Issue.objects.filter(pk=issue.pk).update(state_id=triage_state.id)
            issue.state_id = triage_state.id
            intake = Intake.objects.filter(project=project, is_default=True).first()
            if not intake:
                intake = Intake.objects.create(
                    name=f"{project.name} Intake",
                    project=project,
                    is_default=True,
                )
            intake_issue = IntakeIssue.objects.create(
                intake_id=intake.id,
                project_id=project.id,
                issue_id=issue.id,
                source=SourceType.IN_APP,
            )

        # Fire the same activity hook as the public IssueListCreate
        # endpoint so downstream listeners (the silo Slack-notification
        # fan-out, in particular) see the create event.

        try:
            issue_activity.delay(
                type="issue.activity.created",
                requested_data=_json.dumps(
                    {"name": issue.name, "description_html": issue.description_html or ""}
                ),
                actor_id=str(actor.id),
                issue_id=str(issue.id),
                project_id=str(project.id),
                current_instance=None,
                epoch=int(_tz.now().timestamp()),
                intake=str(intake_issue.id) if intake_issue else None,
            )
        except Exception:
            # Best-effort — activity logging failure shouldn't fail the
            # create. log_exception is overkill since this hits the
            # eager-mode path in dev.
            pass

        return Response(
            {
                "id": str(issue.id),
                "sequence_id": issue.sequence_id,
                "project_identifier": project.identifier,
                "name": issue.name,
                "url": f"/{slug}/projects/{project.id}/issues/{issue.id}",
            },
            status=status.HTTP_201_CREATED,
        )


class SiloAddAssigneeEndpoint(BaseAPIView):
    """Add the resolved Slack→Plane user as an assignee on a work item.

    Powers the "Assign me" button on Slack notification cards. Same
    actor-resolution rules as SiloCreateWorkItemEndpoint; the resolved
    user is the assignee being added (silo notification cards always
    self-assign — there's no separate "assign someone else" form).
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        issue_id = data.get("issue_id")
        actor_id = data.get("actor_user_id")
        slack_user_id = data.get("slack_user_id")

        if not (slug and project_id and issue_id):
            return Response(
                {"detail": "workspace_slug, project_id, issue_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)
        issue = get_object_or_404(Issue, pk=issue_id, project=project)

        actor = None
        if actor_id:
            actor = User.objects.filter(pk=actor_id).first()
        if not actor and slack_user_id:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="slack",
                    connection_id=slack_user_id,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor:
            return Response(
                {"detail": "no Plane account linked for this Slack user"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Membership gate: assignees must be active project members
        # with role >= 15 (member). Same rule the issue serializer
        # enforces; centralize here so the activity log doesn't show
        # a "assigned" entry for a user who isn't actually on the
        # project.
        is_member = ProjectMember.objects.filter(
            project_id=project.id,
            member_id=actor.id,
            role__gte=15,
            is_active=True,
        ).exists()
        if not is_member:
            return Response(
                {"detail": "not a project member"},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Capture the pre-state for the activity log so the
        # "assigned" entry shows the diff (old → new assignee_ids).
        prev_assignee_ids = list(
            IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)
        )
        if actor.id in prev_assignee_ids:
            return Response(
                {"id": str(issue.id), "already_assigned": True},
                status=status.HTTP_200_OK,
            )

        IssueAssignee.objects.create(
            assignee_id=actor.id,
            issue=issue,
            project_id=project.id,
            workspace_id=ws.id,
            created_by_id=actor.id,
            updated_by_id=actor.id,
        )

        # Mirror IssueViewSet.partial_update's activity payload shape:
        # current_instance carries the old assignee_ids; requested_data
        # carries the new full set.

        try:
            issue_activity.delay(
                type="issue.activity.updated",
                requested_data=_json.dumps(
                    {"assignee_ids": [str(uid) for uid in prev_assignee_ids + [actor.id]]}
                ),
                actor_id=str(actor.id),
                issue_id=str(issue.id),
                project_id=str(project.id),
                current_instance=_json.dumps(
                    {"assignee_ids": [str(uid) for uid in prev_assignee_ids]}
                ),
                epoch=int(_tz.now().timestamp()),
                notification=True,
            )
        except Exception:
            pass

        return Response({"id": str(issue.id), "assigned": True}, status=status.HTTP_200_OK)


class SiloChangeStateEndpoint(BaseAPIView):
    """Move a work item to a new state.

    Powers the "Change state" button on Slack notification cards.
    Same actor-resolution rules as SiloCreateWorkItemEndpoint. The
    new state must belong to the same project. Idempotent — no-op
    when the issue is already in the requested state.
    """

    authentication_classes = [SiloHMACAuthentication]
    permission_classes = [IsSiloAuthenticated]

    def post(self, request):

        data = request.data or {}
        slug = data.get("workspace_slug")
        project_id = data.get("project_id")
        issue_id = data.get("issue_id")
        state_id = data.get("state_id")
        actor_id = data.get("actor_user_id")
        slack_user_id = data.get("slack_user_id")
        slack_team_id = data.get("slack_team_id")

        if not (slug and project_id and issue_id and state_id):
            return Response(
                {"detail": "workspace_slug, project_id, issue_id, state_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ws = get_object_or_404(Workspace, slug=slug)
        project = get_object_or_404(Project, pk=project_id, workspace=ws)
        issue = get_object_or_404(Issue, pk=issue_id, project=project)
        new_state = State.objects.filter(pk=state_id, project=project).first()
        if not new_state:
            return Response(
                {"detail": "state_id is not from this project"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        actor = None
        if actor_id:
            actor = User.objects.filter(pk=actor_id).first()
        if not actor and slack_user_id:
            uc = (
                WorkspaceUserConnection.objects.filter(
                    workspace=ws,
                    connection_type="slack",
                    connection_id=slack_user_id,
                )
                .select_related("user")
                .first()
            )
            if uc:
                actor = uc.user
        if not actor and slack_team_id:
            cred = WorkspaceCredential.objects.filter(
                workspace=ws, source="slack", source_identifier=slack_team_id
            ).first()
            if cred:
                actor = cred.user
        if not actor:
            return Response(
                {"detail": "could not resolve actor"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        prev_state_id = issue.state_id
        if prev_state_id == new_state.id:
            return Response({"id": str(issue.id), "unchanged": True}, status=status.HTTP_200_OK)

        # Going through issue.save() (not .update()) so the model's
        # _sync_completed_at hook fires when transitioning to/from
        # completed states. Override the crum thread-local user for
        # the save so updated_by gets the resolved actor instead of
        # silo's anonymous HMAC principal; restore in finally so we
        # never leak crum state across requests on the same worker.
        prev_user = get_current_user()
        prev_request_user = request.user
        set_current_user(actor)
        request.user = actor
        try:
            issue.state = new_state
            issue.save()
        finally:
            set_current_user(prev_user)
            request.user = prev_request_user


        try:
            issue_activity.delay(
                type="issue.activity.updated",
                requested_data=_json.dumps({"state_id": str(new_state.id)}),
                actor_id=str(actor.id),
                issue_id=str(issue.id),
                project_id=str(project.id),
                current_instance=_json.dumps(
                    {"state_id": str(prev_state_id) if prev_state_id else None}
                ),
                epoch=int(_tz.now().timestamp()),
                notification=True,
            )
        except Exception:
            pass

        return Response(
            {
                "id": str(issue.id),
                "state_id": str(new_state.id),
                "state_name": new_state.name,
                "state_group": new_state.group,
            },
            status=status.HTTP_200_OK,
        )


# -- credentials -----------------------------------------------------------


class WorkspaceCredentialListCreateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        ws = _workspace(slug)
        qs = WorkspaceCredential.objects.filter(workspace=ws)
        if source := request.query_params.get("source"):
            qs = qs.filter(source=source)
        if user_id := request.query_params.get("user_id"):
            qs = qs.filter(user_id=user_id)
        return Response(WorkspaceCredentialSerializer(qs, many=True).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        ws = _workspace(slug)
        serializer = WorkspaceCredentialSerializer(data=request.data, context={"workspace": ws})
        serializer.is_valid(raise_exception=True)
        serializer.save(workspace=ws, user=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class WorkspaceCredentialDetailEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, pk):
        cred = get_object_or_404(WorkspaceCredential, workspace__slug=slug, pk=pk)
        return Response(WorkspaceCredentialSerializer(cred).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, pk):
        cred = get_object_or_404(WorkspaceCredential, workspace__slug=slug, pk=pk)
        serializer = WorkspaceCredentialSerializer(cred, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, pk):
        # Instance-level .delete() so BaseModel's soft-delete logic runs.
        # QuerySet.delete() would do a hard SQL delete and skip it.
        cred = get_object_or_404(WorkspaceCredential, workspace__slug=slug, pk=pk)
        cred.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceCredentialTokenVerifyEndpoint(BaseAPIView):
    """Lightweight liveness check for a credential row.

    silo can later add provider-specific verification (auth.test for
    Slack, /user for GitHub) at this endpoint. Phase 1 just reports
    row existence + is_active.
    """

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        cred_id = request.data.get("credential_id")
        if not cred_id:
            return Response(
                {"isAuthenticated": False, "isOAuthEnabled": False},
                status=status.HTTP_400_BAD_REQUEST,
            )
        cred = WorkspaceCredential.objects.filter(workspace__slug=slug, pk=cred_id).first()
        return Response(
            {
                "isAuthenticated": bool(cred and cred.is_active),
                "isOAuthEnabled": bool(cred and not cred.is_pat),
            }
        )


# -- workspace connections -------------------------------------------------


class WorkspaceConnectionListCreateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        qs = WorkspaceConnection.objects.filter(workspace__slug=slug).select_related("credential")
        if ct := request.query_params.get("connection_type"):
            qs = qs.filter(connection_type=ct)
        return Response(WorkspaceConnectionSerializer(qs, many=True).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        ws = _workspace(slug)
        serializer = WorkspaceConnectionSerializer(data=request.data, context={"workspace": ws})
        serializer.is_valid(raise_exception=True)
        serializer.save(workspace=ws)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class WorkspaceConnectionDetailEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, pk):
        conn = get_object_or_404(
            WorkspaceConnection, workspace__slug=slug, pk=pk, deleted_at__isnull=True
        )
        return Response(WorkspaceConnectionSerializer(conn).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, pk):
        conn = get_object_or_404(
            WorkspaceConnection, workspace__slug=slug, pk=pk, deleted_at__isnull=True
        )
        serializer = WorkspaceConnectionSerializer(
            conn, data=request.data, partial=True, context={"workspace": conn.workspace}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, pk):
        # Instance-level .delete() to honour BaseModel's soft-delete.
        conn = get_object_or_404(WorkspaceConnection, workspace__slug=slug, pk=pk)
        conn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# -- per-user connections --------------------------------------------------


class WorkspaceUserConnectionListCreateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        qs = WorkspaceUserConnection.objects.filter(workspace__slug=slug)
        # Members see their own; admins see all.
        is_admin = WorkspaceMember.objects.filter(
            workspace__slug=slug, member=request.user, role=ROLE.ADMIN.value, is_active=True
        ).exists()
        if not is_admin:
            qs = qs.filter(user=request.user)
        if ct := request.query_params.get("connection_type"):
            qs = qs.filter(connection_type=ct)
        return Response(WorkspaceUserConnectionSerializer(qs, many=True).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        ws = _workspace(slug)
        serializer = WorkspaceUserConnectionSerializer(data=request.data, context={"workspace": ws})
        serializer.is_valid(raise_exception=True)
        serializer.save(workspace=ws, user=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class WorkspaceUserConnectionDetailEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, pk):
        conn = get_object_or_404(WorkspaceUserConnection, workspace__slug=slug, pk=pk)
        if conn.user_id != request.user.id:
            is_admin = WorkspaceMember.objects.filter(
                workspace=conn.workspace, member=request.user, role=ROLE.ADMIN.value, is_active=True
            ).exists()
            if not is_admin:
                return Response(status=status.HTTP_404_NOT_FOUND)
        return Response(WorkspaceUserConnectionSerializer(conn).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def delete(self, request, slug, pk):
        conn = get_object_or_404(WorkspaceUserConnection, workspace__slug=slug, pk=pk)
        if conn.user_id != request.user.id:
            is_admin = WorkspaceMember.objects.filter(
                workspace=conn.workspace, member=request.user, role=ROLE.ADMIN.value, is_active=True
            ).exists()
            if not is_admin:
                return Response(status=status.HTTP_403_FORBIDDEN)
        conn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# -- entity connections (project ↔ channel/repo bindings) ------------------


class WorkspaceEntityConnectionListCreateEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        qs = WorkspaceEntityConnection.objects.filter(workspace__slug=slug)
        if wc := request.query_params.get("workspace_connection_id"):
            qs = qs.filter(workspace_connection_id=wc)
        if pid := request.query_params.get("project_id"):
            qs = qs.filter(project_id=pid)
        if ct := request.query_params.get("type"):
            qs = qs.filter(type=ct)
        return Response(WorkspaceEntityConnectionSerializer(qs, many=True).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        ws = _workspace(slug)
        serializer = WorkspaceEntityConnectionSerializer(data=request.data, context={"workspace": ws})
        serializer.is_valid(raise_exception=True)
        serializer.save(workspace=ws)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class WorkspaceEntityConnectionDetailEndpoint(BaseAPIView):
    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, pk):
        conn = get_object_or_404(WorkspaceEntityConnection, workspace__slug=slug, pk=pk)
        return Response(WorkspaceEntityConnectionSerializer(conn).data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, pk):
        conn = get_object_or_404(WorkspaceEntityConnection, workspace__slug=slug, pk=pk)
        serializer = WorkspaceEntityConnectionSerializer(
            conn, data=request.data, partial=True, context={"workspace": conn.workspace}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @allow_permission(allowed_roles=[ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, pk):
        # Instance-level .delete() to honour BaseModel's soft-delete.
        conn = get_object_or_404(WorkspaceEntityConnection, workspace__slug=slug, pk=pk)
        conn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)