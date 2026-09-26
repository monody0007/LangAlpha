import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { queryKeys } from '@/lib/queryKeys';
import { getFlashWorkspace } from '@/pages/ChatAgent/utils/api';
import type { ScopeWorkspace } from '@/pages/Plugins/components/ScopeControl';

/**
 * The query every surface reading `workspaces.flash()` shares, so none can
 * fetch it without the catalog refresh below.
 *
 * The request upserts the row, and the insert switches Flash off for every
 * server new workspaces start without, which a catalog read from before it
 * lacks. A fetch with the row already cached cannot be that insert, so only
 * one on an empty cache refetches the catalog.
 */
export function flashWorkspaceQuery(queryClient: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.workspaces.flash(),
    queryFn: async () => {
      const first = queryClient.getQueryData(queryKeys.workspaces.flash()) === undefined;
      const workspace = await getFlashWorkspace();
      if (first) void queryClient.invalidateQueries({ queryKey: queryKeys.mcp.catalog() });
      return workspace;
    },
    staleTime: Infinity,
  });
}

/**
 * The Flash workspace as a scope-control option, or `undefined` until it
 * resolves.
 *
 * Flash runs on one per-user workspace that the gallery listing hides. It is
 * upserted on first use, so ensure it here: a server can be switched off for
 * Flash before the user ever opens a Flash chat.
 */
export function useFlashWorkspace(): ScopeWorkspace | undefined {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(flashWorkspaceQuery(queryClient));
  const id = data?.workspace_id;
  return id ? { id, name: t('plugins.scope.flash') } : undefined;
}
