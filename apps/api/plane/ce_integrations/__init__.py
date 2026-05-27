# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Zebaria fork: re-implementation of the integrations API surface.
#
# Plane CE ships orphaned Integration / WorkspaceIntegration / SlackProjectSync
# models (apps/api/plane/db/models/integration/) but no views, urls, or
# serializers — those live only in the closed-source commercial silo.
#
# This app restores the views the CE frontend already calls
# (/api/integrations/, /api/workspaces/<slug>/workspace-integrations/)
# so the Workspace Settings → Integrations page renders. Phase-1 of the
# plan in corpinfra (we replace silo's behavior in subsequent phases).
