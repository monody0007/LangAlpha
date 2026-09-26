import { afterEach, describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { renderHookWithProviders } from '@/test/utils';

const api = vi.hoisted(() => ({
  getFlashWorkspace: vi.fn(async () => ({ workspace_id: 'flash-1' })),
}));
vi.mock('@/pages/ChatAgent/utils/api/workspaces', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlashWorkspace: api.getFlashWorkspace,
}));

import { queryKeys } from '@/lib/queryKeys';
import { useFlashWorkspace } from '../useFlashWorkspace';

afterEach(() => {
  api.getFlashWorkspace.mockClear();
});

/**
 * A catalog read before Flash exists: the insert that ensures Flash switches it
 * off for every server new workspaces start without, which this read lacks.
 * The test client's `gcTime: 0` would drop it before the hook runs.
 */
function clientWithCatalog(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.mcp.catalog(), { servers: [] });
  return queryClient;
}

describe('useFlashWorkspace', () => {
  it('refetches the MCP catalog once the first fetch ensures Flash', async () => {
    const queryClient = clientWithCatalog();
    const { result } = renderHookWithProviders(() => useFlashWorkspace(), { queryClient });

    await waitFor(() => expect(result.current?.id).toBe('flash-1'));
    expect(queryClient.getQueryState(queryKeys.mcp.catalog())?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it('leaves the catalog alone on a refresh, which cannot be the insert', async () => {
    const queryClient = clientWithCatalog();
    queryClient.setQueryData(queryKeys.workspaces.flash(), { workspace_id: 'flash-1' });
    // What creating a regular workspace does to the Flash key.
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    renderHookWithProviders(() => useFlashWorkspace(), { queryClient });

    await waitFor(() => expect(api.getFlashWorkspace).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.workspaces.flash())?.isInvalidated).toBe(false),
    );
    expect(queryClient.getQueryState(queryKeys.mcp.catalog())?.isInvalidated).toBe(false);
    queryClient.clear();
  });
});
