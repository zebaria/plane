# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.conf import settings

# Module imports
from plane.license.utils.instance_value import get_configuration_value


def is_allowed_attachment_type(mime_type):
    """Return True if an attachment of the given MIME type may be uploaded.

    A falsy mime_type is always rejected. When the instance config
    ENABLE_ALL_ATTACHMENT_TYPES is "1", any non-empty type is accepted;
    otherwise the type must be in settings.ATTACHMENT_MIME_TYPES.

    Enabling all types is safe against inline stored-XSS because script-capable
    types are force-downloaded on serve (settings.SCRIPT_CAPABLE_MIME_TYPES).
    """
    if not mime_type:
        return False

    (enable_all_attachment_types,) = get_configuration_value(
        [
            {
                "key": "ENABLE_ALL_ATTACHMENT_TYPES",
                "default": "0",
            }
        ]
    )

    if enable_all_attachment_types == "1":
        return True

    return mime_type in settings.ATTACHMENT_MIME_TYPES