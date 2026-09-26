"""The one per-user lock every account-level write shares."""

from __future__ import annotations


async def lock_user_writes(cur, user_id: str) -> None:
    """Take the per-user write lock; it holds until the transaction ends.

    One key for the MCP server creates and deletes, the skill, plugin and
    secret caps, and workspace inserts, so a write that touches several of
    them never waits on a second lock it could deadlock against. A workspace
    insert takes it as its own statement BEFORE the INSERT: waiting after it
    would hold the new row's name and folder slots while a rename blocked on
    those slots holds a row this holder's version bump needs.
    """
    await cur.execute(
        "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
    )
