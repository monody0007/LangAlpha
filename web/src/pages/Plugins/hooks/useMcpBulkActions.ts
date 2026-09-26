import { useTranslation } from 'react-i18next';
import {
  deleteMcpCatalogServer,
  setBuiltinMcpServerEnabled,
  setMcpCatalogServerEnabled,
  setMcpCatalogServerNewWorkspaces,
  setWorkspaceMcpServerEnabled,
  type BuiltinMcpServer,
  type CatalogServer,
} from '@/pages/ChatAgent/utils/api';
import { useFlashWorkspace } from '@/hooks/useFlashWorkspace';
import type { BulkAction } from '../components/BulkActionBar';
import type { BulkScopeSpec } from '../components/BulkScopeMenu';
import { scopeLocked, type ScopeWorkspace } from '../components/ScopeControl';
import { bulkSelectionKey, type BulkTarget } from '../components/useBulkSelection';
import { isPluginOwned } from '../utils/provenance';
import type { PluginListSurface } from './usePluginListSurface';
import { useScopeBulk } from './useScopeBulk';

/**
 * The select-mode actions for the MCP tab. One selection spans two row tiers
 * with different endpoints, so the keys are tier-namespaced and the rows
 * travel as a tagged union rather than as parallel arrays; the scope
 * algorithm downstream wants one list.
 */

type McpScopeRow =
  | { tier: 'builtin'; server: BuiltinMcpServer }
  | { tier: 'catalog'; server: CatalogServer };

const rowKey = (row: McpScopeRow) => `${row.tier}:${row.server.name}`;

export function useMcpBulkActions({
  builtins,
  catalog,
  surface,
  workspaces,
}: {
  builtins: readonly BuiltinMcpServer[];
  catalog: readonly CatalogServer[];
  surface: PluginListSurface;
  workspaces: ScopeWorkspace[];
}): { actions: BulkAction[]; scope: BulkScopeSpec; count: number; selectionKey: string } {
  const { t } = useTranslation();
  const { selected } = surface.selection;
  const flashWorkspace = useFlashWorkspace();

  const rows: McpScopeRow[] = [
    ...builtins.map((server) => ({ tier: 'builtin' as const, server })),
    ...catalog.map((server) => ({ tier: 'catalog' as const, server })),
  ].filter((row) => selected.has(rowKey(row)));

  function toggleTargets(enabled: boolean): BulkTarget[] {
    return rows.flatMap((row) => {
      if (!!row.server.enabled === enabled) return [];
      const key = rowKey(row);
      const { name } = row.server;
      return [
        {
          key,
          run: () =>
            row.tier === 'builtin'
              ? setBuiltinMcpServerEnabled(name, enabled)
              : setMcpCatalogServerEnabled(name, enabled),
        },
      ];
    });
  }

  // Same eligibility as each row's ScopeControl: a locked checklist, off or
  // under a plugin that is off, is out. No move: every server lives on the account.
  const scope = useScopeBulk<McpScopeRow>(rows, {
    workspaces,
    run: surface.run,
    key: rowKey,
    denyMarkers: (row) =>
      scopeLocked(row.server) ? null : (row.server.disabled_workspace_ids ?? []),
    // The row's rule: only a server with a directly bound tool lists Flash.
    flashWorkspaceId: (row) =>
      row.tier === 'catalog' && row.server.has_direct_tools ? (flashWorkspace?.id ?? null) : null,
    setWorkspaceEnabled: (row, workspaceId, enabled) =>
      setWorkspaceMcpServerEnabled(workspaceId, row.server.name, enabled),
    // Only a user row (brokerages included) has the setting. Absent reads as
    // on, like the badge: every row inherited before the setting existed.
    newWorkspaces: (row, on) => {
      if (row.tier !== 'catalog') return null;
      const current = row.server.enabled_in_new_workspaces !== false;
      return current === on
        ? null
        : () => setMcpCatalogServerNewWorkspaces(row.server.name, on);
    },
  });

  // Builtins have no delete, and plugin-owned rows uninstall through their
  // plugin — bulk delete covers only the user's own catalog rows.
  const deleteTargets = rows.filter(
    (row) => row.tier === 'catalog' && !isPluginOwned(row.server),
  );
  const enableCount = toggleTargets(true).length;
  const disableCount = toggleTargets(false).length;

  const actions: BulkAction[] = [
    {
      id: 'enable',
      label: t('plugins.bulk.enable', { count: enableCount }),
      disabled: enableCount === 0,
      run: () => surface.run(toggleTargets(true)),
    },
    {
      id: 'disable',
      label: t('plugins.bulk.disable', { count: disableCount }),
      disabled: disableCount === 0,
      run: () => surface.run(toggleTargets(false)),
    },
    {
      id: 'delete',
      label: t('plugins.bulk.delete', { count: deleteTargets.length }),
      destructive: true,
      disabled: deleteTargets.length === 0,
      confirmMessage: t('plugins.bulk.confirmDelete', { count: deleteTargets.length }),
      run: () =>
        surface.run(
          deleteTargets.map((row) => ({
            key: rowKey(row),
            run: () => deleteMcpCatalogServer(row.server.name),
          })),
        ),
    },
  ];

  return { actions, scope, count: rows.length, selectionKey: bulkSelectionKey(rows.map(rowKey)) };
}
