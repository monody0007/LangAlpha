"""Seam: moving workspace folders to follow their names, and clearing deleted ones.

One file of the ComputerManager split; see the package __init__.

A rename writes the name only. The folder follows the next time the computer
is acquired, before any folder on it is used: that is the one moment nothing
on the computer runs (while anything does, the folders wait for a later
acquisition) and every sandbox path is about to be resolved from the row anyway.
"""

import asyncio
import base64
import json
import logging
import shlex
import textwrap
import uuid
from typing import Any, Dict, Optional

import anyio
from ptc_agent.core.paths import SandboxLayout, workspace_root

from src.server.database.computer import DEFAULT_ROOT_DIR
from src.server.database.session_lock import await_settled
from src.server.database.workspace import (
    complete_workspace_folder_cleanup,
    defer_workspace_folder_cleanup,
    get_workspace_dir_name,
)
from src.server.database.workspace_folders import (
    FOLDER_LAYOUT_VERSION,
    LEFTOVERS_DIR,
    MOVING_DIR,
    accepted_landings,
    busy_workspace_ids,
    computer_run_in_progress,
    hold_workspace_folder,
    is_top_level,
    leftovers_path,
    plan_folder_moves,
    read_folder_rows,
    record_folder_landings,
    retarget_folder_cleanup,
    stage_folder_moves,
    workspace_folders_lock,
)

logger = logging.getLogger(__name__)

_EXEC_TIMEOUT_S = 60
# The script ends itself this long after it starts: room for its 30 s wait on
# the ledger lock and then the moves, and inside the exec timeout, so a pass
# the host still waits for has reported or died by then.
_SCRIPT_LIMIT_S = 45
# From the exec reaching the sandbox to the script arming its limit.
_SCRIPT_START_S = 5

# Runs in the sandbox as one pass, holding the tool ledger's flock from the
# first rename to the ledger rewrite: the ledger records each claim's folder,
# and a sibling's sync reads a missing folder as a deleted workspace.
_SCRIPT = textwrap.dedent(r"""
    import signal, sys
    # First, so a pass the host lost track of is dead before the host lets its
    # locks go. The default action rather than a handler, which Python runs
    # only between bytecodes; dying anywhere leaves what a crash leaves, and
    # the journal below recovers that. Reset, since an ignored or blocked
    # signal survives exec.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, [signal.SIGALRM])
    signal.alarm(int(sys.argv[2]))
    import datetime, fcntl, json, os, secrets, time
    with open(sys.argv[1], encoding="utf-8") as fh:
        A = json.load(fh)
    os.unlink(sys.argv[1])
    ROOT = A["root"]

    def path(rel):
        return os.path.join(ROOT, rel)

    def exists(rel):
        return bool(rel) and os.path.lexists(path(rel))

    def rename(src, dst):
        os.makedirs(os.path.dirname(path(dst)), exist_ok=True)
        os.rename(path(src), path(dst))

    out = {"moves": {}, "tombstones": {}, "evicted": [], "errors": []}
    stamp = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")

    def set_aside(rel):
        # Cut so the suffix still fits a 255-byte name, or the rename fails
        # on every pass and the row it clears the way for never lands.
        base = os.path.basename(rel).encode("utf-8")[:200].decode("utf-8", "ignore")
        away = "%s/%s-%s-%s" % (A["leftovers"], base, stamp, secrets.token_hex(3))
        rename(rel, away)
        out["evicted"].append([rel, away])

    os.makedirs(os.path.dirname(A["lock"]), exist_ok=True)
    lock = open(A["lock"], "a+")
    deadline = time.time() + 30
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.time() > deadline:
                # Nothing moved: a row staged this pass goes back to its folder.
                out["errors"].append("ledger flock timeout")
                for m in A["moves"]:
                    if not m.get("staged") and m.get("source"):
                        out["moves"][m["id"]] = m["source"]
                print(json.dumps(out))
                sys.exit(0)
            time.sleep(0.2)

    # Where each landing put a folder, written before the rename, taken back if
    # the rename fails, and dropped once a later pass moves the content on: a
    # pass whose landings never reached the database leaves its rows staged,
    # and by the next pass a rename may have changed their target, so only
    # this says where the content went. "t:<id>" is the same for a deleted
    # workspace's folder moved aside, kept while the row is still to clear,
    # this pass or a later one. An entry for a row the database no longer has
    # staged is stale, and goes before anything moves.
    journal_path = path(A["moving"] + "/landed.json")
    try:
        with open(journal_path, encoding="utf-8") as fh:
            journal = json.load(fh)
    except (OSError, ValueError):
        journal = {}
    if not isinstance(journal, dict):
        journal = {}

    def save_journal():
        os.makedirs(os.path.dirname(journal_path), exist_ok=True)
        tmp = "%s.%d.tmp" % (journal_path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(journal, fh)
        os.replace(tmp, journal_path)

    if A.get("prune"):
        keep = {r["id"] for r in A["moves"] + A["tombstones"] if r.get("staged")}
        keep |= {"t:" + tid for tid in [r["id"] for r in A["tombstones"]] + A["deferred"]}
        journal = {k: v for k, v in journal.items() if k in keep}
        save_journal()

    def journaled(key, value, src, dst):
        journal[key] = value
        save_journal()
        try:
            rename(src, dst)
        except OSError:
            journal.pop(key, None)
            save_journal()
            raise

    def landing(key, planned=()):
        # Code in this sandbox can write the journal, and followed, an entry
        # naming another row's folder moves that folder into this row. So only
        # what a pass could have written counts: a deleted workspace's folder
        # goes to its own leftovers, a row onto a folder the database recorded
        # a pass planning for it. Anything else is as if never journaled.
        at = journal.get(key)
        if key.startswith("t:"):
            ok = at == A["leftovers"] + "/" + key[2:]
        else:
            ok = isinstance(at, str) and at in planned
        if at is not None and not ok:
            out["errors"].append("journal %s: ignored %r" % (key, at))
        return at if ok else None

    # Where each staged row's last landing left its content. That can be
    # another row's old folder (two rows traded names, or one took the other's
    # former name), so no row falls back to an old folder claimed here. No pass
    # lands two rows on one folder, so of two claims to one at least one is
    # false; nothing says which, and the folder is left to nobody.
    trusted, claims = {}, {}
    for m in A["moves"]:
        at = landing(m["id"], m.get("landings") or ()) if m.get("staged") else None
        if exists(at):
            trusted[m["id"]] = at
            claims.setdefault(at.casefold(), []).append(m["id"])
    claimed = {}
    for folded, ids in claims.items():
        claimed[folded] = ids[0] if len(ids) == 1 else None
        if len(ids) > 1:
            for mid in ids:
                out["errors"].append("journal %s: ignored %r" % (mid, trusted.pop(mid)))

    def unclaimed(rel, owner):
        return exists(rel) and claimed.get(rel.casefold(), owner) == owner

    # Folders that must not be landed on this pass: a deleted workspace's row
    # still points at one it could not clear, and a row that could not stage
    # still holds its own.
    held = set()
    for t in A["tombstones"]:
        tid = t["id"]
        dst = A["leftovers"] + "/" + tid
        done = landing("t:" + tid)
        if exists(done):
            # An earlier pass moved it and never recorded that: whatever sits
            # at its old folder now is another workspace's. An entry whose
            # folder is missing was written by a pass that died before the
            # rename, so the folder is still where the row says.
            out["tombstones"][tid] = done
            continue
        if t.get("staged"):
            # Mid-move: its last landing, its staging, or a source never staged.
            places = (landing(tid, t.get("landings") or ()), t["dir"], t.get("source"))
        else:
            places = (t["dir"],)
        # Its clearing ends in an rm, so never a folder a live row's landing claims.
        src = next((p for p in places if unclaimed(p, tid)), None)
        try:
            if src is not None:
                if exists(dst):
                    rename(dst, dst + "-" + secrets.token_hex(3))
                journaled("t:" + tid, dst, src, dst)
            out["tombstones"][tid] = dst if exists(dst) else None
        except OSError as exc:
            if src:
                held.add(src.casefold())
            out["errors"].append("tombstone %s: %s" % (tid, exc))

    # Everything moving leaves first, so a folder one row vacates is free for
    # the next, and two rows can trade names.
    staged, failed = {}, set()
    for m in A["moves"]:
        mid = m["id"]
        stage = A["moving"] + "/" + mid
        landed_at = trusted.get(mid)
        try:
            if landed_at:
                # The last landing happened. A staging folder since then holds
                # only what an acquisition wrote to the row's staged path.
                if exists(stage):
                    set_aside(stage)
                rename(landed_at, stage)
            else:
                if not m.get("staged") and exists(stage):
                    # Not this row's content: the row was not staged until now.
                    set_aside(stage)
                if not exists(stage) and unclaimed(m.get("source"), mid):
                    rename(m["source"], stage)
            staged[mid] = exists(stage)
        except OSError as exc:
            out["errors"].append("stage %s: %s" % (mid, exc))
            failed.add(mid)
            # Point the row at wherever its content still is, and keep every
            # landing off it; a row with its content staged stays staged.
            if not m.get("staged"):
                here = m.get("source")
            else:
                here = landed_at if exists(landed_at) else None
            if here:
                out["moves"][mid] = here
                held.add(here.casefold())
    # An entry left naming a folder the content has left would claim whatever
    # a later pass lands there; only one whose content is still in it stays.
    stale = [
        m["id"] for m in A["moves"]
        if m.get("staged") and m["id"] in journal
        and not (m["id"] in failed and m["id"] in trusted)
    ]
    if stale:
        for mid in stale:
            del journal[mid]
        try:
            save_journal()
        except OSError as exc:
            out["errors"].append("journal: %s" % exc)

    landed = set()
    for m in A["moves"]:
        mid, target = m["id"], m["target"]
        stage = A["moving"] + "/" + mid
        if mid in failed:
            continue
        if target.casefold() in held:
            out["errors"].append("land %s: %s is held this pass" % (mid, target))
            if staged.get(mid):
                out["moves"][mid] = stage
            continue
        try:
            if exists(target):
                if target.casefold() in landed:
                    raise OSError("target filled by another move in this pass")
                # No row holds it, or the plan would not land here: an unowned
                # folder, kept where nothing will mistake it for this workspace.
                set_aside(target)
            if staged.get(mid):
                journaled(mid, target, stage, target)
            # Otherwise nothing is anywhere, a folder never made or a sandbox
            # rebuilt empty, and the name alone is this row's.
            out["moves"][mid] = target
            landed.add(target.casefold())
        except OSError as exc:
            out["errors"].append("land %s: %s" % (mid, exc))
            if staged.get(mid):
                out["moves"][mid] = stage

    try:
        with open(A["ledger"], encoding="utf-8") as fh:
            ledger = json.load(fh)
    except FileNotFoundError:
        ledger = None
    except (OSError, ValueError) as exc:
        ledger = None
        out["errors"].append("ledger: %s" % exc)
    dirs = ledger.get("dirs") if isinstance(ledger, dict) else None
    if isinstance(dirs, dict):
        for claim, folder in list(out["moves"].items()) + list(out["tombstones"].items()):
            if claim in dirs and folder:
                dirs[claim] = folder
        tmp = "%s.%d.tmp" % (A["ledger"], os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(ledger, fh, sort_keys=True, indent=2)
            fh.write("\n")
        os.replace(tmp, A["ledger"])
    fcntl.flock(lock, fcntl.LOCK_UN)
    print(json.dumps(out))
""")


def _command(args_path: str) -> str:
    code = base64.b64encode(_SCRIPT.encode("utf-8")).decode("ascii")
    # Isolated, because the sandbox runs this from the computer root: a
    # workspace named ``json`` holding an ``__init__.py`` would be imported in
    # place of the standard library's, and fail every retry with rows staged.
    return (
        f"python3 -I -c \"import base64;exec(base64.b64decode('{code}').decode())\" "
        f"{shlex.quote(args_path)} {_SCRIPT_LIMIT_S}"
    )


class FolderScriptNotStarted(RuntimeError):
    """The script never ran, so nothing on the disk moved."""


async def _outlast_script() -> None:
    """Keep the caller's folder locks until a script the host lost is dead.

    A timed-out Docker exec only stops reading, and a failed or cancelled call
    on either provider leaves the command running; it may have started as late
    as the moment the host gave up. Released sooner, the locks would let a file
    change or another settle use folders the script is still moving. The
    caller is often here because it was cancelled, and AnyIO cancels again at
    every await, so the wait is shielded.
    """
    with anyio.CancelScope(shield=True):
        await await_settled(
            asyncio.ensure_future(asyncio.sleep(_SCRIPT_LIMIT_S + _SCRIPT_START_S))
        )


async def _run_folder_script(
    runtime: Any,
    root: str,
    *,
    moves: list,
    tombstones: list,
    prune: bool,
    deferred: tuple[str, ...] = (),
) -> Dict[str, Any]:
    layout = SandboxLayout.for_root(root)
    args = {
        "root": root,
        "moving": MOVING_DIR,
        "leftovers": LEFTOVERS_DIR,
        "ledger": layout.union_ledger,
        "lock": layout.union_lock,
        "tombstones": tombstones,
        "moves": moves,
        "deferred": list(deferred),
        "prune": prune,
    }
    # The plan goes up as a file: a shell command is one argument string, which
    # the kernel caps at 128 KiB, and a plan of long non-Latin names passes that.
    args_path = f"{layout.internal}/.folders_args.{uuid.uuid4().hex}.json"
    try:
        await runtime.upload_file(json.dumps(args).encode("utf-8"), args_path)
    except Exception as e:
        raise FolderScriptNotStarted(f"could not upload the folder plan: {e}") from e
    try:
        result = await runtime.exec(_command(args_path), timeout=_EXEC_TIMEOUT_S)
    except (Exception, asyncio.CancelledError):
        await _outlast_script()
        raise
    lines = (result.stdout or "").strip().splitlines()
    if result.exit_code != 0 or not lines:
        if not (isinstance(result.exit_code, int) and result.exit_code >= 0):
            # No exit status (Docker's -1 on a timeout): it may still be running.
            await _outlast_script()
        raise RuntimeError(
            f"folder script exited {result.exit_code}: {(result.stderr or result.stdout or '')[:500]}"
        )
    report = json.loads(lines[-1])
    if not isinstance(report, dict):
        raise RuntimeError("folder script printed no report")
    return report


class FolderSettleMixin:
    async def _settle_folders(
        self,
        computer_id: str,
        runtime: Any,
        *,
        root: Optional[str] = None,
        own_run_id: Optional[str] = None,
        ignore_busy: bool = False,
    ) -> bool:
        """Move every folder on this computer that can follow its name now.

        True when a row changed. Never raises for a move it could not make: the
        workspace keeps its current folder and the next acquisition retries.
        ``ignore_busy`` is for a sandbox that was just built, where no process
        can be using any folder whatever the run ledger says.
        """
        version, rows = await read_folder_rows(computer_id)
        if (version or 0) < FOLDER_LAYOUT_VERSION or not plan_folder_moves(rows):
            return False
        if not ignore_busy and not plan_folder_moves(
            rows, await busy_workspace_ids(computer_id, rows, own_run_id=own_run_id)
        ):
            # Only a busy workspace would move: nothing to lock for yet.
            return False
        root = root or DEFAULT_ROOT_DIR
        async with workspace_folders_lock(computer_id) as conn:
            if conn is None:
                return False
            plan = await stage_folder_moves(
                conn, computer_id, own_run_id=own_run_id, ignore_busy=ignore_busy
            )
            if not plan:
                return False
            try:
                report = await _run_folder_script(
                    runtime,
                    root,
                    tombstones=[
                        {
                            "id": t.workspace_id,
                            "dir": t.dir_name,
                            "source": t.source,
                            "staged": t.staged,
                            "landings": list(t.landings),
                        }
                        for t in plan.tombstones
                    ],
                    moves=[
                        {
                            "id": m.workspace_id,
                            "source": m.source,
                            "target": m.target,
                            "staged": m.staged,
                            "landings": list(m.landings),
                        }
                        for m in plan.moves
                    ],
                    deferred=plan.deferred,
                    prune=True,
                )
            except FolderScriptNotStarted as e:
                # Nothing moved, as when the script cannot take the ledger lock:
                # a row staged this pass goes back to its folder.
                logger.warning(f"Folder settle on computer {computer_id} did not start: {e}")
                report = {"moves": {m.workspace_id: m.source for m in plan.moves if not m.staged}}
            except Exception as e:
                # The rows stay staged; the next settle finds the content.
                logger.warning(f"Folder settle on computer {computer_id} failed: {e}")
                return True
            for error in report.get("errors") or ():
                logger.warning(f"Folder settle on computer {computer_id}: {error}")
            for folder, away in report.get("evicted") or ():
                logger.info(
                    f"Moved unowned folder {folder!r} on computer {computer_id} to {away}"
                )
            moves, tombstones = accepted_landings(plan, report)
            landed = await record_folder_landings(
                conn, computer_id, moves=moves, tombstones=tombstones
            )
            logger.info(
                f"Settled folders on computer {computer_id}: "
                f"{sorted((m.workspace_id, moves[m.workspace_id]) for m in plan.moves if m.workspace_id in landed)}"
                f", cleared {len(tombstones)} deleted"
            )
            return True

    async def _remove_workspace_folder(
        self,
        workspace_id: str,
        workspace: Dict[str, Any],
        computer: Dict[str, Any],
    ) -> bool:
        """Do not boot stopped machines just to remove mirrored, unreferenced files.

        Recreation restores only live projects from the mirror, removing these
        leftovers without an extra provider round trip. A folder still at the
        top level moves under ``_internal/leftovers`` first, under the folder
        lock, so the name is free before the slow ``rm`` and a workspace that
        reuses it never shares the path being removed."""
        dir_name = (workspace.get("dir_name") or "").strip("/")
        if not (is_top_level(dir_name) or dir_name == leftovers_path(workspace_id)):
            # Without a project folder, the path is the machine runtime root: never unlink it.
            return False
        if dir_name in (".", ".."):
            return False
        provider_ref = computer.get("provider_ref")
        if not provider_ref or computer.get("status") != "running":
            return False

        computer_id = str(computer["computer_id"])
        root = computer.get("root_dir") or DEFAULT_ROOT_DIR
        binding = self._binding_from_computer(workspace_id, computer)
        try:
            # The local handle may be stale or absent; address the durable machine ref.
            async with self._detached_runtime(provider_ref, binding=binding) as runtime:
                from src.server.services.egress.session_binding import refresh_computer_grant_map

                try:
                    await refresh_computer_grant_map(
                        runtime,
                        root=root,
                        computer_id=computer_id,
                        user_id=computer["user_id"],
                    )
                except Exception:
                    logger.warning("Could not refresh egress map after workspace deletion", exc_info=True)
                if is_top_level(dir_name):
                    moved = await self._clear_tombstone_folder(
                        computer_id, runtime, root, workspace_id, dir_name
                    )
                    if moved is None:
                        # Never on this disk: nothing to remove.
                        await complete_workspace_folder_cleanup(
                            workspace_id, computer_id=computer_id, dir_name=dir_name,
                        )
                        return True
                    dir_name = moved
                target = workspace_root(root, dir_name)
                result = await runtime.exec(f"rm -rf {shlex.quote(target)}")
                if result.exit_code != 0:
                    raise RuntimeError(
                        f"folder removal exited {result.exit_code}: {result.stdout}"
                    )
            await complete_workspace_folder_cleanup(
                workspace_id, computer_id=computer_id, dir_name=dir_name,
            )
            logger.info(
                f"Removed folder {target} of workspace {workspace_id} from "
                f"sandbox {provider_ref}"
            )
            return True
        except Exception as e:
            # The tombstoned workspace carries the durable retry claim. Touching
            # it moves a broken candidate behind newer cleanup work.
            try:
                await defer_workspace_folder_cleanup(
                    workspace_id, computer_id=computer_id, dir_name=dir_name,
                )
            except Exception:
                logger.warning(
                    "Could not defer failed folder cleanup for workspace %s",
                    workspace_id,
                    exc_info=True,
                )
            logger.warning(
                f"Could not remove folder {dir_name} of workspace {workspace_id} "
                f"from sandbox {provider_ref}: {e}"
            )
            return False

    async def _clear_tombstone_folder(
        self, computer_id: str, runtime: Any, root: str, workspace_id: str, dir_name: str
    ) -> Optional[str]:
        """Move a deleted workspace's folder aside and record where; None if it was absent."""
        async with workspace_folders_lock(computer_id) as conn:
            if conn is None:
                raise RuntimeError("the folder lock is busy")
            # The caller read the row before this lock. A settle since then may
            # have moved the folder aside and handed its name to a live
            # workspace, whose folder the script would otherwise take.
            current = await get_workspace_dir_name(workspace_id, conn=conn)
            if current != dir_name:
                if current not in (None, leftovers_path(workspace_id)):
                    raise RuntimeError(f"deleted workspace now records folder {current!r}")
                return current
            if await computer_run_in_progress(conn, computer_id):
                # A sibling's code reaches this folder as ../<folder>; a write
                # after the move would recreate the name for the next
                # workspace to take it. The settle defers tombstones the same way.
                raise RuntimeError("a run on the computer may be using the folder")
            if not await hold_workspace_folder(conn, workspace_id):
                # A change that read this folder before the delete is still
                # writing; moving it now would let that write recreate it.
                raise RuntimeError("a file change still holds the folder")
            report = await _run_folder_script(
                runtime,
                root,
                moves=[],
                tombstones=[
                    {"id": workspace_id, "dir": dir_name, "source": dir_name, "staged": False}
                ],
                prune=False,
            )
            tombstones = report.get("tombstones") or {}
            if not isinstance(tombstones, dict) or workspace_id not in tombstones:
                raise RuntimeError("; ".join(map(str, report.get("errors") or ["no report"])))
            moved = tombstones[workspace_id]
            if moved not in (None, leftovers_path(workspace_id)):
                raise RuntimeError(f"folder script reported {moved!r} for a deleted workspace")
            if moved is not None:
                await retarget_folder_cleanup(
                    workspace_id, computer_id=computer_id, dir_name=dir_name, folder=moved
                )
            return moved
