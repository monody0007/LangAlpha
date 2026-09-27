"""What the database keeps of each folder a settle planned for a staged row.

The move script trusts its journal only where it names one of these, so the
list has to grow with every pass that plans a new folder, and go once nothing
can be sitting on one: the row landed, or another row took the folder. The
SQL itself is pinned against a real server in the integration suite; these pin
what each statement is handed.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest

from src.server.database import workspace_folders
from src.server.database.workspace_folders import (
    leftovers_path,
    moving_path,
    record_folder_landings,
    release_former_folder,
    stage_folder_moves,
)

A, B, C = (str(uuid.UUID(int=i)) for i in (1, 2, 3))
D, E = (str(uuid.UUID(int=i)) for i in (4, 5))


class _Cursor:
    def __init__(self, *fetches):
        self.fetches = list(fetches)
        self.calls: list[tuple[str, object]] = []
        self.rowcount = 1

    async def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.split()), params))

    async def fetchall(self):
        return self.fetches.pop(0) if self.fetches else []

    async def fetchone(self):
        return None

    def updates(self):
        return [(sql, params) for sql, params in self.calls if sql.startswith("UPDATE")]


class _Conn:
    def __init__(self, cur):
        self.cur = cur

    @asynccontextmanager
    async def transaction(self):
        yield

    @asynccontextmanager
    async def cursor(self, **_kwargs):
        yield self.cur


def _record(workspace_id, name, dir_name, previous=(), landings=None):
    return {
        "workspace_id": uuid.UUID(workspace_id),
        "name": name,
        "dir_name": dir_name,
        "deleted": False,
        "previous_dir_names": list(previous),
        "landings": landings,
    }


@pytest.mark.asyncio
async def test_staging_adds_the_planned_folder_to_what_earlier_passes_recorded():
    """A retried pass plans again: a folder already recorded is not written
    twice, and a row staged now starts a fresh list whatever its config held."""
    cur = _Cursor([
        _record(A, "Final", moving_path(A), ["Research"], ["Macro"]),
        _record(B, "Notes", moving_path(B), ["Drafts"], ["Notes"]),
        _record(C, "New", "Stale", landings=["Junk"]),
    ])
    with patch.object(workspace_folders, "hold_workspace_folder", AsyncMock(return_value=True)):
        plan = await stage_folder_moves(_Conn(cur), "computer", ignore_busy=True)

    assert {m.workspace_id for m in plan.moves} == {A, B, C}
    written = {
        params["id"]: ("previous_dir_names" in sql, params["landings"].obj)
        for sql, params in cur.updates()
    }
    assert written == {A: (False, ["Macro", "Final"]), C: (True, ["New"])}


@pytest.mark.asyncio
async def test_a_row_that_leaves_staging_drops_its_planned_landings():
    """Reported back at its staging, a row is still mid-move and keeps them."""
    cur = _Cursor()
    landed = await record_folder_landings(
        _Conn(cur),
        "computer",
        moves={A: "Macro", B: moving_path(B)},
        tombstones={D: None, E: leftovers_path(E)},
    )
    assert landed == {A, B}
    tombstones, moves = cur.updates()[:2], cur.updates()[2:]
    assert all("#- '{folder_landings}'" in sql for sql, _ in tombstones)
    moved = [(params["id"], params["landed"]) for sql, params in moves if "dir_name =" in sql]
    assert moved == [(A, True), (B, False)]
    assert all(
        "THEN config #- '{folder_landings}' ELSE config" in sql
        for sql, params in moves
        if isinstance(params, dict) and "landed" in params
    )


@pytest.mark.asyncio
async def test_a_folder_taken_stops_being_any_staged_siblings_landing():
    """The folder now holds this workspace's content, which the sibling's
    move script would take back as its own on a journal entry naming it.
    Matched under casefold, which Postgres's ``lower`` is not."""
    cur = _Cursor(
        [],
        [
            {"workspace_id": A, "landings": ["STRASSE", "Other", 5]},
            {"workspace_id": B, "landings": ["Else"]},
            {"workspace_id": C, "landings": {"Straße": True}},
            {"workspace_id": D, "landings": None},
        ],
    )
    await release_former_folder(cur, computer_id="computer", workspace_id=E, folder="Straße")
    stripped = [(params[1], params[0].obj) for sql, params in cur.updates()]
    assert stripped == [(A, ["Other"])]


@pytest.mark.asyncio
async def test_a_new_folder_is_never_one_a_staged_row_may_have_landed_on():
    from src.server.database.workspace import get_workspace_dir_names_for_computer

    cur = _Cursor([
        {"folder": "Research", "landing": None, "landings": None},
        {"folder": "Old", "landing": "Final", "landings": ["Macro", 7, "Final"]},
        {"folder": "Other", "landing": "Other", "landings": "Junk"},
    ])
    held = await get_workspace_dir_names_for_computer("computer", conn=_Conn(cur))
    assert set(held) == {"Research", "Old", "Other", "Macro", "Final"}


@pytest.mark.asyncio
async def test_a_config_replace_keeps_the_rows_planned_landings():
    """The client writes ``config`` whole; the settle's list is not its to set."""
    from src.server.database.workspace import update_workspace

    cur = _Cursor()
    await update_workspace(A, config={"folder_landings": ["Sibling"], "theme": "dark"}, conn=_Conn(cur))
    [(sql, params)] = cur.updates()
    assert (
        "config = (%s::jsonb - 'folder_landings') || CASE WHEN config ? 'folder_landings'"
        " THEN jsonb_build_object('folder_landings', config->'folder_landings')"
        " ELSE '{}'::jsonb END"
    ) in sql
    assert params[0].obj == {"folder_landings": ["Sibling"], "theme": "dark"}
