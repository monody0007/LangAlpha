import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';

import { queryKeys } from '@/lib/queryKeys';
import { invalidateNewWorkspace, invalidateWorkspaceMembership } from '../workspaceRowActions';

it('invalidates workspace and computer projections after membership changes', () => {
  const client = new QueryClient();
  const workspaces = queryKeys.workspaces.lists();
  const computers = queryKeys.computers.lists();
  // Shares the `computers` prefix, and costs a `du` on the machine: a
  // membership change must not re-read it.
  const storage = queryKeys.computers.storage('c1');
  client.setQueryData(workspaces, { workspaces: [] });
  client.setQueryData(computers, { computers: [] });
  client.setQueryData(storage, { live: true, workspaces: [], other_bytes: 0 });

  invalidateWorkspaceMembership(client);

  expect(client.getQueryState(workspaces)?.isInvalidated).toBe(true);
  expect(client.getQueryState(computers)?.isInvalidated).toBe(true);
  expect(client.getQueryState(storage)?.isInvalidated).toBe(false);
  client.clear();
});

it('also refreshes the MCP catalog after a workspace is created', () => {
  // The new workspace is seeded switched off for servers new workspaces start
  // without, and the Plugins scope badges read that off the catalog.
  const client = new QueryClient();
  const catalog = queryKeys.mcp.catalog();
  const builtins = queryKeys.mcp.builtins();
  client.setQueryData(catalog, { servers: [], max_servers: 50 });
  client.setQueryData(builtins, { servers: [] });

  invalidateNewWorkspace(client);

  expect(client.getQueryState(catalog)?.isInvalidated).toBe(true);
  // Builtins always start on in a new workspace; nothing there changed.
  expect(client.getQueryState(builtins)?.isInvalidated).toBe(false);
  client.clear();
});
