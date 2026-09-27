"""Dispatch picks a free workspace name before it creates one; these tests run
without a database, so every name is free."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture(autouse=True)
def _every_workspace_name_is_free():
    with patch(
        "src.server.database.workspace.get_workspace_name_keys",
        AsyncMock(return_value=set()),
    ):
        yield
