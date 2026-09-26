import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '@/test/utils';

// Inline dropdown, as in BulkScopeMenu.test: jsdom does not drive Radix portals.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e?: { preventDefault: () => void }) => void;
  }) => (
    <button role="menuitem" onClick={() => onSelect?.({ preventDefault: () => {} })}>
      {children}
    </button>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onSelect,
  }: {
    children: React.ReactNode;
    checked?: boolean;
    onSelect?: (e?: { preventDefault: () => void }) => void;
  }) => (
    <button
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="submenu">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ data: { workspaces: [{ workspace_id: 'ws-1', name: 'Research' }] } }),
}));
vi.mock('@/pages/ChatAgent/utils/api/workspaces', () => ({
  getFlashWorkspace: vi.fn().mockResolvedValue({ workspace_id: 'flash-1' }),
}));

import { ScopeControl } from '../components/ScopeControl';
import { McpCatalogRow } from '../components/McpCatalogRow';
import { BrokerageRow } from '../components/BrokerageRow';
import { BulkScopeMenu } from '../components/BulkScopeMenu';
import { useFlashWorkspace } from '@/hooks/useFlashWorkspace';
import { useWorkspaceOptions } from '../hooks/useWorkspaceOptions';

const workspaces = [{ id: 'ws-1', name: 'Research' }];
const flashWorkspace = { id: 'flash-1', name: 'Flash' };

describe('ScopeControl with the Flash workspace', () => {
  it('lists Flash last with its note only when the row can reach it', () => {
    const onSet = vi.fn();
    renderWithProviders(
      <ScopeControl
        workspaces={workspaces}
        scopeWorkspaceId={null}
        disabledWorkspaceIds={['flash-1']}
        flashWorkspace={flashWorkspace}
        onSetWorkspaceDisabled={onSet}
        onMove={vi.fn()}
      />,
    );
    const checks = screen.getAllByRole('menuitemcheckbox');
    expect(checks.map((el) => el.textContent)).toEqual(['Research', 'Flash']);
    expect(checks.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(screen.getByText(/Flash reaches only the tools bound as Direct/)).toBeInTheDocument();
    // Flash is never a move destination.
    const moves = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(moves).toContain('Research');
    expect(moves).not.toContain('Flash');
    // The disabled Flash entry still counts toward the label.
    expect(screen.getByText('All workspaces except 1')).toBeInTheDocument();

    fireEvent.click(checks[1]);
    expect(onSet).toHaveBeenCalledWith('flash-1', false);
  });

  it('keeps Flash out of rows that cannot reach it', () => {
    renderWithProviders(
      <ScopeControl
        workspaces={workspaces}
        scopeWorkspaceId={null}
        disabledWorkspaceIds={['flash-1']}
        onSetWorkspaceDisabled={vi.fn()}
      />,
    );
    expect(screen.queryByText('Flash')).not.toBeInTheDocument();
    expect(screen.getByText('All workspaces')).toBeInTheDocument();
  });

  it('keeps Flash out of the bulk move-to-workspace destinations', async () => {
    function Harness() {
      const { workspaces: wsOptions } = useWorkspaceOptions();
      const flash = useFlashWorkspace();
      return (
        <>
          <span data-testid="flash-resolved">{flash?.id ?? 'none'}</span>
          <BulkScopeMenu
            workspaces={wsOptions}
            everywhereCount={2}
            onEverywhere={vi.fn()}
            onlyInCount={2}
            onOnlyIn={vi.fn()}
            move={{ count: 2, onMoveTo: vi.fn() }}
          />
        </>
      );
    }
    renderWithProviders(<Harness />);
    // The move list is only meaningful once Flash has actually resolved:
    // an unresolved query would pass this test for the wrong reason.
    await screen.findByText('flash-1');

    const moveSub = screen
      .getAllByTestId('submenu')
      .find((el) => el.textContent?.includes('Move into workspace'));
    expect(moveSub).toBeDefined();
    expect(within(moveSub as HTMLElement).getByText('Research')).toBeInTheDocument();
    expect(within(moveSub as HTMLElement).queryByText('Flash')).not.toBeInTheDocument();
    // Nor anywhere else in the bulk menu: the "Only in" checklist writes a
    // deny the Skills tab's ScopeControl could not display or undo.
    expect(screen.queryByText('Flash')).not.toBeInTheDocument();
  });
});


describe('McpCatalogRow deciding whether Flash is reachable', () => {
  const base = {
    name: 'moomoo',
    transport: 'http' as const,
    enabled: true,
    url: 'https://example.com/mcp',
    args: [],
    env: {},
    headers: {},
    env_refs: [],
    header_refs: [],
  };

  // Flash resolves through a query, so the checklist only settles once it has.
  // The probe shares the cache with the row, which is what makes the negative
  // assertion mean "withheld" rather than "not resolved yet".
  function Probe() {
    const flash = useFlashWorkspace();
    return <span data-testid="flash-resolved">{flash?.id ?? 'none'}</span>;
  }

  function renderRow(has_direct_tools: boolean) {
    renderWithProviders(
      <>
      <Probe />
      <McpCatalogRow
        server={{ ...base, has_direct_tools } as never}
        vendor={null}
        workspaces={workspaces}
        selection={{ has: () => false, toggle: vi.fn() } as never}
        connecting={false}
        refreshing={false}
        toggling={false}
        scopeBusy={false}
        onOpen={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onRefreshSchemas={vi.fn()}
        onEdit={vi.fn()}
        onRequestDelete={vi.fn()}
        onToggle={vi.fn()}
        onSetWorkspaceDisabled={vi.fn()}
        onSetNewWorkspacesOn={vi.fn()}
      />
      </>,
    );
  }

  async function checklist(): Promise<string[]> {
    await waitFor(() =>
      expect(screen.getByTestId('flash-resolved')).toHaveTextContent('flash-1'),
    );
    fireEvent.click(screen.getByRole('button', { name: /workspace|scope|active in/i }));
    const items = await screen.findAllByRole('menuitemcheckbox');
    return items.map((el) => el.textContent ?? '');
  }

  it('offers Flash on a row that has a directly bound tool', async () => {
    renderRow(true);
    expect(await checklist()).toContain('Flash');
  });

  it('withholds Flash from a PTC-only row', async () => {
    renderRow(false);
    const items = await checklist();
    expect(items).toContain('Research');
    expect(items).not.toContain('Flash');
  });
});

describe('BrokerageRow deciding whether Flash is reachable', () => {
  // The same question as the MCP tab's row, asked of the brokerage tab's:
  // a connection granting only PTC-bound capabilities binds Flash nothing,
  // so offering the scope would persist a marker that changes nothing.
  function Probe() {
    const flash = useFlashWorkspace();
    return <span data-testid="flash-resolved">{flash?.id ?? 'none'}</span>;
  }

  function renderRow(has_direct_tools: boolean) {
    renderWithProviders(
      <>
        <Probe />
        <BrokerageRow
          brokerage={{ name: 'moomoo', label: 'moomoo' } as never}
          row={
            {
              name: 'moomoo',
              transport: 'http',
              enabled: true,
              oauth_status: 'connected',
              disabled_workspace_ids: [],
              has_direct_tools,
            } as never
          }
          vendor={null}
          workspaces={workspaces}
          connecting={false}
          refreshing={false}
          toggling={false}
          scopeBusy={false}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onRefreshSchemas={vi.fn()}
          onToggle={vi.fn()}
          onRequestRemove={vi.fn()}
          onSetWorkspaceDisabled={vi.fn()}
          onSetNewWorkspacesOn={vi.fn()}
          onOpenInMcpTab={vi.fn()}
          onOpen={vi.fn()}
        />
      </>,
    );
  }

  async function checklist(): Promise<string[]> {
    await waitFor(() =>
      expect(screen.getByTestId('flash-resolved')).toHaveTextContent('flash-1'),
    );
    fireEvent.click(screen.getByRole('button', { name: /workspace|scope|active in/i }));
    const items = await screen.findAllByRole('menuitemcheckbox');
    return items.map((el) => el.textContent ?? '');
  }

  it('offers Flash on a brokerage with a directly bound tool', async () => {
    renderRow(true);
    expect(await checklist()).toContain('Flash');
  });

  it('withholds Flash from a brokerage granting only sandbox tools', async () => {
    renderRow(false);
    const items = await checklist();
    expect(items).toContain('Research');
    expect(items).not.toContain('Flash');
  });
});
