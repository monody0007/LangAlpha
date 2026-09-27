"""The in-sandbox move script, run for real against a scratch disk.

It is the one piece that renames user files, so each case runs the actual
script in a subprocess over a temporary root rather than asserting on its
text: the moves land, the tool ledger follows them, and nothing is ever
deleted, only moved aside under ``_internal``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from src.server.services.computer_manager._folders import _SCRIPT, _SCRIPT_LIMIT_S

LEFTOVERS = "_internal/leftovers"
MOVING = "_internal/moving"


def _args(
    root: Path,
    *,
    moves=(),
    tombstones=(),
    deferred=(),
    ledger: dict | None = None,
    prune: bool = True,
) -> Path:
    ledger_path = root / "_internal" / "ledger.json"
    if ledger is not None:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(json.dumps(ledger))
    # A staged row's ``landings`` are what the database recorded earlier
    # passes planning for it: the only folders its journal entry may name.
    moves = [{"staged": False, "landings": [], **m} for m in moves]
    tombstones = [{"staged": False, "source": t["dir"], "landings": [], **t} for t in tombstones]
    args = {
        "root": str(root),
        "moving": MOVING,
        "leftovers": LEFTOVERS,
        "ledger": str(ledger_path),
        "lock": str(root / "_internal" / "ledger.lock"),
        "moves": moves,
        "tombstones": tombstones,
        "deferred": list(deferred),
        "prune": prune,
    }
    args_path = root.parent / "folders_args.json"
    args_path.write_text(json.dumps(args))
    return args_path


def _run(root: Path, **plan) -> dict:
    args_path = _args(root, **plan)
    done = subprocess.run(
        [sys.executable, "-c", _SCRIPT, str(args_path), str(_SCRIPT_LIMIT_S)],
        capture_output=True, text=True, check=True, timeout=_SCRIPT_LIMIT_S + 15,
    )
    assert not args_path.exists()
    return json.loads(done.stdout.strip().splitlines()[-1])


def _folder(root: Path, name: str, marker: str) -> None:
    (root / name).mkdir(parents=True)
    (root / name / "owner.txt").write_text(marker)


def _owner(root: Path, name: str) -> str:
    return (root / name / "owner.txt").read_text()


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "workspace"


def test_a_rename_moves_the_folder_and_the_ledger_follows(root):
    _folder(root, "Research", "A")
    report = _run(
        root,
        moves=[{"id": "A", "source": "Research", "target": "Macro"}],
        ledger={"dirs": {"A": "Research", "B": "Other"}},
    )
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"
    assert not (root / "Research").exists()
    ledger = json.loads((root / "_internal" / "ledger.json").read_text())
    assert ledger["dirs"] == {"A": "Macro", "B": "Other"}


def test_two_workspaces_trade_names(root):
    _folder(root, "X", "A")
    _folder(root, "Y", "B")
    report = _run(
        root,
        moves=[
            {"id": "A", "source": "X", "target": "Y"},
            {"id": "B", "source": "Y", "target": "X"},
        ],
    )
    assert report["errors"] == []
    assert (_owner(root, "Y"), _owner(root, "X")) == ("A", "B")


def test_a_deleted_workspace_is_moved_aside_before_its_name_is_reused(root):
    _folder(root, "Research", "dead")
    _folder(root, "Research-1a2b", "A")
    report = _run(
        root,
        tombstones=[{"id": "D", "dir": "Research"}],
        moves=[{"id": "A", "source": "Research-1a2b", "target": "Research"}],
    )
    assert report["tombstones"] == {"D": f"{LEFTOVERS}/D"}
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert _owner(root, "Research") == "A"


def test_an_unowned_folder_on_the_target_is_kept_aside_not_merged(root):
    _folder(root, "Macro", "stray")
    _folder(root, "Research", "A")
    report = _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    [(folder, away)] = report["evicted"]
    assert folder == "Macro" and away.startswith(f"{LEFTOVERS}/Macro-")
    assert _owner(root, away) == "stray"
    assert _owner(root, "Macro") == "A"


def test_a_move_never_lands_on_a_deleted_workspace_it_could_not_clear(root):
    """The tombstone's row still points at the folder, so its cleanup would
    remove whatever landed there: the mover stays staged instead."""
    _folder(root, "Research", "dead")
    _folder(root, "Research-1a2b", "A")
    # A file where the leftovers folder should be makes the tombstone's move fail.
    (root / "_internal").mkdir(parents=True)
    (root / LEFTOVERS).write_text("")
    report = _run(
        root,
        tombstones=[{"id": "D", "dir": "Research"}],
        moves=[{"id": "A", "source": "Research-1a2b", "target": "Research"}],
    )
    assert "D" not in report["tombstones"]
    assert report["moves"] == {"A": f"{MOVING}/A"}
    assert _owner(root, "Research") == "dead"
    assert _owner(root, f"{MOVING}/A") == "A"


def test_a_move_interrupted_after_staging_finishes_from_staging(root):
    _folder(root, f"{MOVING}/A", "A")
    report = _run(
        root, moves=[{"id": "A", "source": "Research", "target": "Macro", "staged": True}]
    )
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"


def test_a_workspace_whose_folder_was_never_made_takes_its_name(root):
    root.mkdir(parents=True)
    report = _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    assert report["moves"] == {"A": "Macro"}
    assert report["errors"] == []


def test_a_workspace_with_no_folder_does_not_take_an_unowned_one(root):
    """Files left at its name by no row are not this workspace's."""
    _folder(root, "Macro", "stray")
    report = _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    assert report["moves"] == {"A": "Macro"}
    [(folder, away)] = report["evicted"]
    assert folder == "Macro" and _owner(root, away) == "stray"
    assert not (root / "Macro").exists()


def test_a_landing_the_database_never_recorded_is_found_after_a_rename(root):
    """The row stays staged when its landing fails to record, and a rename
    before the next pass changes its target: the journal says where it went."""
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    assert _owner(root, "Macro") == "A"
    report = _run(
        root,
        moves=[{
            "id": "A", "source": "Research", "target": "Final", "staged": True,
            "landings": ["Macro"],
        }],
    )
    assert report["moves"] == {"A": "Final"}
    assert _owner(root, "Final") == "A"
    assert not (root / "Macro").exists()


def test_the_journal_only_answers_for_a_row_still_staged(root):
    """A row staged this pass moves from its source; an entry left from an
    earlier move names a folder that may be someone else's by now."""
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    _folder(root, "Notes", "A again")
    report = _run(root, moves=[{"id": "A", "source": "Notes", "target": "Notes 2"}])
    assert report["moves"] == {"A": "Notes 2"}
    assert _owner(root, "Notes 2") == "A again"
    assert _owner(root, "Macro") == "A"


def test_a_recorded_landing_drops_out_of_the_journal(root):
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    _folder(root, "X", "B")
    _run(root, moves=[{"id": "B", "source": "X", "target": "Y"}])
    journal = json.loads((root / MOVING / "landed.json").read_text())
    assert journal == {"B": "Y"}


def test_a_workspace_deleted_mid_move_clears_what_its_last_landing_left(root):
    """Its row points at staging, but the landing reached the disk: the
    folder it landed in is its, not a free name for the next workspace."""
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    report = _run(
        root,
        tombstones=[{"id": "A", "dir": f"{MOVING}/A", "staged": True, "landings": ["Macro"]}],
    )
    assert report["tombstones"] == {"A": f"{LEFTOVERS}/A"}
    assert _owner(root, f"{LEFTOVERS}/A") == "A"
    assert not (root / "Macro").exists()


def test_a_workspace_deleted_while_staged_clears_its_staging(root):
    _folder(root, f"{MOVING}/A", "A")
    report = _run(root, tombstones=[{"id": "A", "dir": f"{MOVING}/A", "staged": True}])
    assert report["tombstones"] == {"A": f"{LEFTOVERS}/A"}
    assert not (root / MOVING / "A").exists()


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root renames out of a read-only directory",
)
def test_a_move_that_cannot_stage_keeps_its_folder(root):
    """Reporting the target would point the row at an empty folder while its
    files stay behind, owned by no row."""
    _folder(root, "Research", "A")
    (root / MOVING).mkdir(parents=True)
    # A root nothing can be renamed out of; the journal and lock still write.
    root.chmod(0o555)
    try:
        report = _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    finally:
        root.chmod(0o755)
    assert report["moves"] == {"A": "Research"}
    assert _owner(root, "Research") == "A"
    assert not (root / "Macro").exists()


def test_a_retried_pass_does_not_clear_a_landed_move_as_a_tombstone(root):
    """The first pass cleared the deleted folder and landed the mover on its
    name, then never recorded either: the tombstone row still names the folder
    the mover now holds."""
    _folder(root, "Research", "dead")
    _folder(root, "Research-1a2b", "A")
    first = dict(
        tombstones=[{"id": "D", "dir": "Research"}],
        moves=[{"id": "A", "source": "Research-1a2b", "target": "Research"}],
    )
    _run(root, **first)
    report = _run(
        root,
        tombstones=[{"id": "D", "dir": "Research"}],
        moves=[{
            "id": "A", "source": "Research-1a2b", "target": "Research", "staged": True,
            "landings": ["Research"],
        }],
    )
    assert report["tombstones"] == {"D": f"{LEFTOVERS}/D"}
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert _owner(root, "Research") == "A"


def test_a_landing_on_a_deferred_tombstones_cleared_folder_is_still_found(root):
    """As above, but the retry leaves the tombstone (past the pass cap, or a
    file change holds it), so its row still names the folder: its journal
    entry says the dead content left, and what is there is the mover's."""
    _folder(root, "Research", "dead")
    _folder(root, "Research-1a2b", "A")
    _run(
        root,
        tombstones=[{"id": "D", "dir": "Research"}],
        moves=[{"id": "A", "source": "Research-1a2b", "target": "Research"}],
    )
    report = _run(
        root,
        moves=[{
            "id": "A", "source": "Research-1a2b", "target": "Research-1a2b", "staged": True,
            "landings": ["Research"],
        }],
        deferred=["D"],
    )
    assert report["moves"] == {"A": "Research-1a2b"}
    assert _owner(root, "Research-1a2b") == "A"
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert not (root / "Research").exists()


def test_a_tombstone_whose_pass_died_before_the_rename_is_cleared_on_retry(root):
    """The journal entry is written before the rename; a pass that died
    between them leaves the folder in place, and a new workspace taking the
    name would inherit it."""
    _folder(root, "Research", "dead")
    (root / MOVING).mkdir(parents=True)
    (root / MOVING / "landed.json").write_text(json.dumps({"t:D": f"{LEFTOVERS}/D"}))
    report = _run(root, tombstones=[{"id": "D", "dir": "Research"}])
    assert report["tombstones"] == {"D": f"{LEFTOVERS}/D"}
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert not (root / "Research").exists()


def test_a_tombstone_left_past_the_pass_cap_keeps_its_journal_entry(root):
    """Its folder left but the database never heard, and the entry is the one
    record of that: without it, whatever sits at the old name by the next pass
    is taken for the deleted workspace's and cleared with it."""
    _folder(root, "Research", "dead")
    _run(root, tombstones=[{"id": "D", "dir": "Research"}])
    _run(root, deferred=["D"])
    _folder(root, "Research", "stray")
    report = _run(root, tombstones=[{"id": "D", "dir": "Research"}])
    assert report["tombstones"] == {"D": f"{LEFTOVERS}/D"}
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert _owner(root, "Research") == "stray"
    # Recorded now, so no pass clears or leaves it: the entry goes.
    _run(root)
    assert json.loads((root / MOVING / "landed.json").read_text()) == {}


def test_a_staging_folder_made_after_the_landing_is_set_aside(root):
    """An acquisition that wrote to the row's staged path after the landing
    made a folder there; the landing, not that folder, is the workspace."""
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    _folder(root, f"{MOVING}/A", "stray")
    report = _run(
        root,
        moves=[{
            "id": "A", "source": "Research", "target": "Macro", "staged": True,
            "landings": ["Macro"],
        }],
    )
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"
    [(folder, away)] = report["evicted"]
    assert folder == f"{MOVING}/A" and _owner(root, away) == "stray"


def test_a_stray_staging_folder_is_not_taken_for_a_row_staged_now(root):
    _folder(root, f"{MOVING}/A", "stray")
    _folder(root, "Research", "A")
    report = _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"
    [(_folder_name, away)] = report["evicted"]
    assert _owner(root, away) == "stray"


def test_a_workspace_deleted_before_its_staging_ran_clears_its_old_folder(root):
    _folder(root, "Research", "A")
    report = _run(
        root,
        tombstones=[{"id": "A", "dir": f"{MOVING}/A", "source": "Research", "staged": True}],
    )
    assert report["tombstones"] == {"A": f"{LEFTOVERS}/A"}
    assert _owner(root, f"{LEFTOVERS}/A") == "A"


def _journal(root: Path, entries: dict) -> None:
    (root / MOVING).mkdir(parents=True, exist_ok=True)
    (root / MOVING / "landed.json").write_text(json.dumps(entries))


def test_a_journal_entry_naming_another_rows_folder_is_ignored(root):
    """Code in the sandbox can write the journal. Followed, an entry naming a
    sibling's folder moves the sibling into this row, and the report still
    reads as the planned landing."""
    _folder(root, f"{MOVING}/A", "A")
    _folder(root, "Sibling", "B")
    _journal(root, {"A": "Sibling"})
    report = _run(
        root,
        moves=[{
            "id": "A", "source": "Research", "target": "Macro", "staged": True,
            "landings": ["Macro"],
        }],
    )
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"
    assert _owner(root, "Sibling") == "B"
    assert any(error.startswith("journal A:") for error in report["errors"])


def test_a_deleted_workspaces_journal_entry_never_clears_a_sibling(root):
    """Its clearing ends in an rm, so following an entry that names a
    sibling's folder would delete the sibling."""
    _folder(root, f"{MOVING}/T", "T")
    _folder(root, "Sibling", "B")
    _journal(root, {"T": "Sibling"})
    report = _run(
        root,
        tombstones=[{"id": "T", "dir": f"{MOVING}/T", "source": "Old", "staged": True}],
    )
    assert report["tombstones"] == {"T": f"{LEFTOVERS}/T"}
    assert _owner(root, f"{LEFTOVERS}/T") == "T"
    assert _owner(root, "Sibling") == "B"


def test_a_tombstone_entry_outside_its_own_leftovers_is_ignored(root):
    """A pass only moves a deleted workspace's folder to its leftovers. An
    entry naming anything else reads as already cleared, and the dead folder
    stays where the next workspace to take the name inherits it."""
    _folder(root, "Research", "dead")
    _folder(root, "Sibling", "B")
    _journal(root, {"t:D": "Sibling"})
    report = _run(root, tombstones=[{"id": "D", "dir": "Research"}])
    assert report["tombstones"] == {"D": f"{LEFTOVERS}/D"}
    assert _owner(root, f"{LEFTOVERS}/D") == "dead"
    assert _owner(root, "Sibling") == "B"


def test_a_tampered_entry_never_takes_another_staged_rows_landing(root):
    """Both rows landed and neither reached the database, then A's entry is
    pointed at B's landing. No pass planned that folder for A, so B takes its
    own content back, and A's, which lost the entry naming it, is kept aside."""
    _folder(root, "X", "A")
    _folder(root, "Z", "B")
    _run(root, moves=[
        {"id": "A", "source": "X", "target": "Y"},
        {"id": "B", "source": "Z", "target": "W"},
    ])
    _journal(root, {"A": "W", "B": "W"})
    report = _run(root, moves=[
        {"id": "A", "source": "X", "target": "Y", "staged": True, "landings": ["Y"]},
        {"id": "B", "source": "Z", "target": "W", "staged": True, "landings": ["W"]},
    ])
    assert "journal A: ignored 'W'" in report["errors"]
    assert report["moves"] == {"A": "Y", "B": "W"}
    assert _owner(root, "W") == "B"
    [(folder, away)] = report["evicted"]
    assert (folder, _owner(root, away)) == ("Y", "A")


def test_a_tampered_entry_never_hands_a_row_the_landing_on_its_old_folder(root):
    """As above, but the two traded names, so B's landing is A's old folder:
    A falling back to it would move B's content into A just the same."""
    _folder(root, "X", "A")
    _folder(root, "Y", "B")
    _run(root, moves=[
        {"id": "A", "source": "X", "target": "Y"},
        {"id": "B", "source": "Y", "target": "X"},
    ])
    _journal(root, {"A": "X", "B": "X"})
    report = _run(root, moves=[
        {"id": "A", "source": "X", "target": "Y", "staged": True, "landings": ["Y"]},
        {"id": "B", "source": "Y", "target": "X", "staged": True, "landings": ["X"]},
    ])
    assert report["moves"] == {"A": "Y", "B": "X"}
    assert _owner(root, "X") == "B"
    [(folder, away)] = report["evicted"]
    assert (folder, _owner(root, away)) == ("Y", "A")


def _run_locked_out(root: Path, **plan) -> dict:
    """A pass that never gets the ledger lock, its 30 s wait cut short."""
    import fcntl

    args_path = _args(root, **plan)
    (root / "_internal").mkdir(parents=True, exist_ok=True)
    later = (
        "import time\n"
        "_now, _calls = time.time, []\n"
        "def _later():\n"
        "    _calls.append(None)\n"
        "    return _now() + (60 if len(_calls) > 1 else 0)\n"
        "time.time = _later\n"
    )
    with open(root / "_internal" / "ledger.lock", "a+") as ledger_lock:
        fcntl.flock(ledger_lock, fcntl.LOCK_EX)
        done = subprocess.run(
            [sys.executable, "-c", later + _SCRIPT, str(args_path), str(_SCRIPT_LIMIT_S)],
            capture_output=True, text=True, check=True, timeout=30,
        )
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_a_landing_outlives_a_later_pass_that_planned_elsewhere_and_moved_nothing(root):
    """Pass 1 landed A on its name and never recorded it. Pass 2 planned its
    old folder instead, as a pass does when the target is held, and timed out
    on the ledger lock. Pass 3 still finds the first landing, which the row
    records beside the second."""
    _folder(root, "Research", "A")
    _run(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    staged = {"id": "A", "source": "Research", "target": "Research", "staged": True}
    timed_out = _run_locked_out(root, moves=[{**staged, "landings": ["Macro"]}])
    assert (timed_out["errors"], timed_out["moves"]) == (["ledger flock timeout"], {})
    report = _run(root, moves=[{**staged, "landings": ["Macro", "Research"]}])
    assert report["moves"] == {"A": "Research"}
    assert _owner(root, "Research") == "A"
    assert not (root / "Macro").exists()


def test_a_landing_taken_back_to_staging_leaves_the_journal(root):
    """A's unrecorded landing, on its old folder while its name was held, goes
    back to staging; A cannot land this pass, and B, renamed to A's old name,
    lands on the folder A left. Neither records. An entry still naming it
    would claim B's content for A."""
    _folder(root, "Research", "A")
    _journal(root, {"A": "Research"})
    _folder(root, "Macro", "dead")
    _folder(root, "Notes", "B")
    # The deleted workspace on A's name cannot clear, so A cannot land there.
    (root / LEFTOVERS).write_text("")
    tombstones = [{"id": "D", "dir": "Macro"}]
    a = {"id": "A", "source": "Research", "target": "Macro", "staged": True}
    b = {"id": "B", "source": "Notes", "target": "Research"}
    blocked = _run(root, tombstones=tombstones, moves=[{**a, "landings": ["Research"]}, b])
    assert blocked["moves"] == {"A": f"{MOVING}/A", "B": "Research"}
    (root / LEFTOVERS).unlink()
    report = _run(root, tombstones=tombstones, moves=[
        {**a, "landings": ["Research", "Macro"]},
        {**b, "staged": True, "landings": ["Research"]},
    ])
    assert report["moves"] == {"A": "Macro", "B": "Research"}
    assert (_owner(root, "Macro"), _owner(root, "Research")) == ("A", "B")


def test_two_entries_naming_one_folder_are_both_ignored(root):
    """No pass lands two rows on one folder, so one entry is false, and
    nothing says which: the folder goes to neither."""
    _folder(root, f"{MOVING}/A", "A")
    _folder(root, "Shared", "B")
    _journal(root, {"A": "Shared", "B": "Shared"})
    report = _run(root, moves=[
        {"id": "A", "source": "Old A", "target": "Mine", "staged": True, "landings": ["Shared"]},
        {"id": "B", "source": "Old B", "target": "Theirs", "staged": True, "landings": ["Shared"]},
    ])
    assert {"journal A: ignored 'Shared'", "journal B: ignored 'Shared'"} <= set(report["errors"])
    assert _owner(root, "Mine") == "A"
    assert _owner(root, "Shared") == "B"
    assert not (root / "Theirs").exists()


def _land_on_a_folder_never_made(root: Path) -> None:
    """A's folder was never made, and B, renamed to A's old name, landed there;
    the pass never reached the database."""
    _folder(root, "Notes", "B")
    _run(root, moves=[
        {"id": "A", "source": "Old", "target": "New"},
        {"id": "B", "source": "Notes", "target": "Old"},
    ])
    assert _owner(root, "Old") == "B"


def test_a_row_falls_back_to_its_old_folder_only_when_no_landing_claims_it(root):
    """A staged row with nothing journaled falls back to its old folder, where
    B's content now is until B takes it back."""
    _land_on_a_folder_never_made(root)
    report = _run(root, moves=[
        {"id": "A", "source": "Old", "target": "New", "staged": True, "landings": ["New"]},
        {"id": "B", "source": "Notes", "target": "Old", "staged": True, "landings": ["Old"]},
    ])
    assert report["errors"] == []
    assert report["moves"] == {"A": "New", "B": "Old"}
    assert _owner(root, "Old") == "B"
    assert not (root / "New").exists()


def test_a_deleted_workspace_never_clears_a_landing_on_its_old_folder(root):
    """As above with A deleted before the retry: its clearing ends in an rm."""
    _land_on_a_folder_never_made(root)
    report = _run(
        root,
        tombstones=[{
            "id": "A", "dir": f"{MOVING}/A", "source": "Old", "staged": True, "landings": ["New"],
        }],
        moves=[{
            "id": "B", "source": "Notes", "target": "Old", "staged": True, "landings": ["Old"],
        }],
    )
    assert report["tombstones"] == {"A": None}
    assert report["moves"] == {"B": "Old"}
    assert _owner(root, "Old") == "B"


def test_a_pass_the_host_lost_ends_itself_at_its_limit(root):
    """A timed-out exec is not killed (Docker only stops reading), and the host
    lets the folder locks go once the limit has passed: whatever the script is
    doing then, here waiting on a ledger lock a sibling's sync holds, it ends.
    The shell ignores the alarm first, as an ignore survives exec."""
    import fcntl
    import signal
    import time

    _folder(root, "Research", "A")
    args_path = _args(root, moves=[{"id": "A", "source": "Research", "target": "Macro"}])
    (root / "_internal").mkdir()
    with open(root / "_internal" / "ledger.lock", "a+") as ledger_lock:
        fcntl.flock(ledger_lock, fcntl.LOCK_EX)
        started = time.monotonic()
        done = subprocess.run(
            ["/bin/sh", "-c", 'trap "" ALRM; exec "$0" -c "$1" "$2" "$3"',
             sys.executable, _SCRIPT, str(args_path), "1"],
            capture_output=True, text=True, timeout=60,
        )
        elapsed = time.monotonic() - started
    assert done.returncode == -signal.SIGALRM, done
    assert done.stdout == ""
    # Well inside the script's 30 s wait for the ledger lock.
    assert elapsed < 15
    assert _owner(root, "Research") == "A"


class _SubprocessRuntime:
    """Runs the command the manager builds, as the sandbox shell would."""

    def __init__(self, cwd=None):
        self.commands = []
        self.cwd = cwd

    async def upload_file(self, content, dest_path):
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        Path(dest_path).write_bytes(content)

    async def exec(self, command, timeout=None):
        self.commands.append(command)
        done = subprocess.run(
            ["/bin/sh", "-c", command.replace("python3 ", f"{sys.executable} ", 1)],
            capture_output=True, text=True, timeout=timeout, cwd=self.cwd,
        )
        return type("Result", (), {
            "exit_code": done.returncode, "stdout": done.stdout, "stderr": done.stderr,
        })()


@pytest.mark.asyncio
async def test_clearing_a_deleted_workspace_runs_the_real_script(root, monkeypatch):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.services.computer_manager import _folders

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    retarget = AsyncMock()
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "retarget_folder_cleanup", retarget)
    monkeypatch.setattr(_folders, "get_workspace_dir_name", AsyncMock(return_value="Research"))
    monkeypatch.setattr(_folders, "computer_run_in_progress", AsyncMock(return_value=False))
    monkeypatch.setattr(_folders, "hold_workspace_folder", AsyncMock(return_value=True))
    _folder(root, "Research", "dead")
    moved = await _folders.FolderSettleMixin._clear_tombstone_folder(
        None, "c", _SubprocessRuntime(), str(root), "D", "Research"
    )
    assert moved == f"{LEFTOVERS}/D"
    assert _owner(root, moved) == "dead"
    retarget.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_deleted_workspace_a_file_change_holds_is_not_cleared_yet(root, monkeypatch):
    """The change read the folder before the delete; the caller defers the
    cleanup and a later pass clears it once the change is done."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.services.computer_manager import _folders

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "get_workspace_dir_name", AsyncMock(return_value="Research"))
    monkeypatch.setattr(_folders, "computer_run_in_progress", AsyncMock(return_value=False))
    monkeypatch.setattr(_folders, "hold_workspace_folder", AsyncMock(return_value=False))
    _folder(root, "Research", "dead")
    runtime = _SubprocessRuntime()
    with pytest.raises(RuntimeError, match="file change"):
        await _folders.FolderSettleMixin._clear_tombstone_folder(
            None, "c", runtime, str(root), "D", "Research"
        )
    assert _owner(root, "Research") == "dead"
    assert runtime.commands == []


@pytest.mark.asyncio
async def test_a_deleted_workspace_is_not_cleared_while_a_sibling_runs(root, monkeypatch):
    """A sibling's code may still write ../Research; moving it now would let
    that write recreate the name for the next workspace to take it."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.services.computer_manager import _folders

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    hold = AsyncMock(return_value=True)
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "get_workspace_dir_name", AsyncMock(return_value="Research"))
    monkeypatch.setattr(_folders, "computer_run_in_progress", AsyncMock(return_value=True))
    monkeypatch.setattr(_folders, "hold_workspace_folder", hold)
    _folder(root, "Research", "dead")
    runtime = _SubprocessRuntime()
    with pytest.raises(RuntimeError, match="run on the computer"):
        await _folders.FolderSettleMixin._clear_tombstone_folder(
            None, "c", runtime, str(root), "D", "Research"
        )
    assert _owner(root, "Research") == "dead"
    assert runtime.commands == []
    hold.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_tombstone_a_settle_cleared_first_leaves_the_names_new_owner_alone(
    root, monkeypatch
):
    """The caller read the row before the lock; a settle since then moved the
    folder aside and a live workspace took the name."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.services.computer_manager import _folders

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    retarget = AsyncMock()
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "retarget_folder_cleanup", retarget)
    monkeypatch.setattr(
        _folders, "get_workspace_dir_name", AsyncMock(return_value=f"{LEFTOVERS}/D")
    )
    _folder(root, "Research", "live")
    runtime = _SubprocessRuntime()
    moved = await _folders.FolderSettleMixin._clear_tombstone_folder(
        None, "c", runtime, str(root), "D", "Research"
    )
    assert moved == f"{LEFTOVERS}/D"
    assert _owner(root, "Research") == "live"
    assert runtime.commands == []
    retarget.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_plan_longer_than_one_shell_argument_still_runs(root):
    """A shell command is one argument string, capped at 128 KiB on Linux;
    200 deleted workspaces with long CJK names serialize past that."""
    from src.server.services.computer_manager import _folders

    names = [f"{i:03d}" + "研" * 77 for i in range(200)]
    tombstones = [
        {"id": f"T{i}", "dir": name, "source": name, "staged": False}
        for i, name in enumerate(names)
    ]
    assert len(json.dumps(tombstones)) > 128 * 1024
    runtime = _SubprocessRuntime()
    report = await _folders._run_folder_script(
        runtime, str(root), moves=[], tombstones=tombstones, prune=True
    )
    assert report["tombstones"] == {t["id"]: None for t in tombstones}
    assert max(map(len, runtime.commands)) < 32 * 1024
    assert list((root / "_internal").glob(".folders_args.*")) == []


@pytest.mark.asyncio
async def test_a_workspace_named_like_a_module_the_script_imports_does_not_break_it(root):
    """The sandbox runs the script from the computer root, beside every
    workspace folder: a package there named ``json`` would be imported in place
    of the standard library's, failing every retry with the rows staged."""
    from src.server.services.computer_manager import _folders

    for module in ("base64", "json"):
        _folder(root, module, module)
        (root / module / "__init__.py").write_text("")
    _folder(root, "Research", "A")
    report = await _folders._run_folder_script(
        _SubprocessRuntime(cwd=root),
        str(root),
        moves=[{"id": "A", "source": "Research", "target": "Macro", "staged": False}],
        tombstones=[],
        prune=True,
    )
    assert report["moves"] == {"A": "Macro"}
    assert _owner(root, "Macro") == "A"


def test_a_long_name_over_an_unowned_folder_still_lands(root):
    """The folder moved aside keeps its name plus a suffix; at 255 bytes the
    suffix does not fit unless the name is cut, and the move would fail on
    every pass."""
    # A CJK name reaches this length in bytes, the sandbox's limit; ASCII
    # reaches it in characters too, so the case fails on any disk.
    long_name = "a" * 240
    _folder(root, "Old", "A")
    _folder(root, long_name, "stray")

    out = _run(root, moves=[{"id": "A", "source": "Old", "target": long_name}])

    assert out["moves"] == {"A": long_name}
    assert _owner(root, long_name) == "A"
    [(_, away)] = out["evicted"]
    assert _owner(root, away) == "stray"

@pytest.mark.asyncio
async def test_a_settle_sends_the_script_every_field_it_reads(root, monkeypatch):
    """The manager's payload and the script's reads drift apart silently: the
    one thing a settle cannot survive is the script dying on a missing key."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.database.workspace_folders import (
        FOLDER_LAYOUT_VERSION, FolderRow, moving_path, plan_folder_moves,
    )
    from src.server.services.computer_manager import _folders

    rows = [
        FolderRow("A", "Macro", "Research", False),
        # Landed on its name by a pass that never recorded it.
        FolderRow("B", "Notes", moving_path("B"), False, ("Drafts",), ("Notes",)),
        FolderRow("D", "Old", "Old", True),
    ]

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    record = AsyncMock(return_value={"A"})
    monkeypatch.setattr(_folders, "read_folder_rows", AsyncMock(return_value=(FOLDER_LAYOUT_VERSION, rows)))
    monkeypatch.setattr(_folders, "busy_workspace_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "stage_folder_moves", AsyncMock(return_value=plan_folder_moves(rows)))
    monkeypatch.setattr(_folders, "record_folder_landings", record)
    _folder(root, "Research", "A")
    _folder(root, "Notes", "B")
    _journal(root, {"B": "Notes"})
    _folder(root, "Old", "dead")

    assert await _folders.FolderSettleMixin._settle_folders(
        None, "c", _SubprocessRuntime(), root=str(root)
    )
    assert record.await_args.kwargs == {
        "moves": {"A": "Macro", "B": "Notes"}, "tombstones": {"D": f"{LEFTOVERS}/D"},
    }
    assert (_owner(root, "Macro"), _owner(root, "Notes")) == ("A", "B")


@pytest.mark.asyncio
async def test_a_settle_whose_script_never_started_puts_its_rows_back(root, monkeypatch):
    """Staged rows are refused by every acquisition until they land; when the
    plan never reached the disk, nothing moved, so the row can go back now."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.database.workspace_folders import (
        FOLDER_LAYOUT_VERSION, FolderRow, moving_path, plan_folder_moves,
    )
    from src.server.services.computer_manager import _folders

    rows = [
        FolderRow("A", "Macro", "Research", False),
        FolderRow("B", "Notes", moving_path("B"), False, ("Drafts",)),
    ]

    @asynccontextmanager
    async def lock(_computer_id):
        yield object()

    class _NoUpload(_SubprocessRuntime):
        async def upload_file(self, content, dest_path):
            raise OSError("disk full")

    runtime = _NoUpload()
    record = AsyncMock(return_value={"A"})
    monkeypatch.setattr(_folders, "read_folder_rows", AsyncMock(return_value=(FOLDER_LAYOUT_VERSION, rows)))
    monkeypatch.setattr(_folders, "busy_workspace_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "stage_folder_moves", AsyncMock(return_value=plan_folder_moves(rows)))
    monkeypatch.setattr(_folders, "record_folder_landings", record)

    assert await _folders.FolderSettleMixin._settle_folders(None, "c", runtime, root=str(root))
    # B was staged by an earlier pass, so its content may be in staging.
    assert record.await_args.kwargs == {"moves": {"A": "Research"}, "tombstones": {}}
    assert not runtime.commands


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["Sibling", "Stray", "../outside", ".agents"])
async def test_a_journal_entry_naming_no_landing_the_row_records_is_ignored(
    root, tmp_path, entry
):
    """Only a folder the database recorded a pass planning for this row is a
    landing. Followed, the entry would pull a sibling, an unowned folder spelled
    like a name, a folder from outside the root, or the computer's own into the
    workspace."""
    from src.server.services.computer_manager import _folders

    _folder(root, f"{MOVING}/A", "A")
    _folder(root, "Sibling", "B")
    _folder(root, "Stray", "stray")
    _folder(tmp_path, "outside", "outside")
    _folder(root, ".agents", "computer")
    _journal(root, {"A": entry})
    report = await _folders._run_folder_script(
        _SubprocessRuntime(),
        str(root),
        moves=[{
            "id": "A", "source": "Research", "target": "Macro", "staged": True,
            "landings": ["Macro"],
        }],
        tombstones=[],
        prune=True,
    )
    assert report["moves"] == {"A": "Macro"}
    assert f"journal A: ignored {entry!r}" in report["errors"]
    assert _owner(root, "Macro") == "A"
    for folder, owner in (("Sibling", "B"), ("Stray", "stray"), (".agents", "computer")):
        assert _owner(root, folder) == owner
    assert _owner(tmp_path, "outside") == "outside"


class _LostExec(_SubprocessRuntime):
    """An exec whose script the host cannot account for, or one that ended."""

    def __init__(self, outcome):
        super().__init__()
        self.outcome = outcome

    async def exec(self, command, timeout=None):
        import asyncio

        self.commands.append(command)
        if self.outcome == "timed out":
            # DockerRuntime.exec on its timeout: the process is never signalled.
            return type("Result", (), {"exit_code": -1, "stdout": "", "stderr": "timeout"})()
        if self.outcome == "failed in transit":
            raise ConnectionError("toolbox unreachable")
        if self.outcome == "cancelled":
            raise asyncio.CancelledError
        if self.outcome == "hangs":
            await asyncio.Event().wait()
        # Died at its own limit: 128 + SIGALRM, an exit status the host saw.
        return type("Result", (), {"exit_code": 142, "stdout": "", "stderr": ""})()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome, waits",
    [("timed out", True), ("failed in transit", True), ("cancelled", True), ("ended", False)],
)
async def test_a_lost_script_keeps_the_folder_locks_until_its_limit_has_passed(
    root, monkeypatch, outcome, waits
):
    """Released sooner, the locks let a file change or another settle use
    folders the script may still be moving. One whose exit the host saw is
    over, and holds nothing up."""
    import asyncio
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from src.server.database.workspace_folders import FOLDER_LAYOUT_VERSION, FolderRow, plan_folder_moves
    from src.server.services.computer_manager import _folders

    rows = [FolderRow("A", "Macro", "Research", False)]
    events = []

    @asynccontextmanager
    async def lock(_computer_id):
        try:
            yield object()
        finally:
            events.append("released")

    async def sleep(seconds):
        events.append(("slept", seconds))

    record = AsyncMock(return_value=set())
    monkeypatch.setattr(asyncio, "sleep", sleep)
    monkeypatch.setattr(_folders, "read_folder_rows", AsyncMock(return_value=(FOLDER_LAYOUT_VERSION, rows)))
    monkeypatch.setattr(_folders, "busy_workspace_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "stage_folder_moves", AsyncMock(return_value=plan_folder_moves(rows)))
    monkeypatch.setattr(_folders, "record_folder_landings", record)

    settle = _folders.FolderSettleMixin._settle_folders(None, "c", _LostExec(outcome), root=str(root))
    if outcome == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            await settle
    else:
        assert await settle
    limit = _folders._SCRIPT_LIMIT_S + _folders._SCRIPT_START_S
    assert events == ([("slept", limit)] if waits else []) + ["released"]
    # The rows stay staged; the next settle finds the content.
    record.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_settle_cancelled_through_anyio_keeps_the_folder_locks_until_its_limit(
    root, monkeypatch
):
    """A server cancels a request through an AnyIO scope, which cancels again
    at every await: the wait for a lost script has to outlast every delivery."""
    import time
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    import anyio

    from src.server.database.workspace_folders import FOLDER_LAYOUT_VERSION, FolderRow, plan_folder_moves
    from src.server.services.computer_manager import _folders

    rows = [FolderRow("A", "Macro", "Research", False)]
    released = []

    @asynccontextmanager
    async def lock(_computer_id):
        try:
            yield object()
        finally:
            released.append(time.monotonic())

    monkeypatch.setattr(_folders, "_SCRIPT_LIMIT_S", 0.3)
    monkeypatch.setattr(_folders, "_SCRIPT_START_S", 0)
    monkeypatch.setattr(_folders, "read_folder_rows", AsyncMock(return_value=(FOLDER_LAYOUT_VERSION, rows)))
    monkeypatch.setattr(_folders, "busy_workspace_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr(_folders, "workspace_folders_lock", lock)
    monkeypatch.setattr(_folders, "stage_folder_moves", AsyncMock(return_value=plan_folder_moves(rows)))
    monkeypatch.setattr(_folders, "record_folder_landings", AsyncMock(return_value=set()))

    start = time.monotonic()
    with anyio.move_on_after(0.05) as scope:
        await _folders.FolderSettleMixin._settle_folders(None, "c", _LostExec("hangs"), root=str(root))
    assert scope.cancelled_caught
    assert released and released[0] - start >= 0.3
