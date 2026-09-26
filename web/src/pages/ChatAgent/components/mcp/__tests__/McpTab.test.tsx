import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { renderWithProviders } from '@/test/utils';
import type { CatalogServerList, EffectiveServer, EffectiveServerList } from '../../../utils/api';

// ---------------------------------------------------------------------------
// Mock the MCP hooks so we drive list data + mutation outcomes directly.
// ---------------------------------------------------------------------------

const mutateAsync = {
  add: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
  discover: vi.fn(),
  import: vi.fn(),
};

let listData: EffectiveServerList | undefined;
let catalogData: CatalogServerList | undefined;

vi.mock('@/hooks/useMcpServers', () => ({
  useMcpCatalog: () => ({ data: catalogData }),
  useWorkspaceMcpServers: () => ({ data: listData, isLoading: false, error: null }),
  useAddWorkspaceMcpServer: () => ({ mutateAsync: mutateAsync.add, isPending: false }),
  useUpdateWorkspaceMcpServer: () => ({ mutateAsync: mutateAsync.update, isPending: false }),
  useToggleWorkspaceMcpServer: () => ({ mutateAsync: mutateAsync.toggle, isPending: false }),
  useDiscoverWorkspaceMcpServer: () => ({ mutateAsync: mutateAsync.discover, isPending: false }),
  useImportWorkspaceMcpServers: () => ({ mutateAsync: mutateAsync.import, isPending: false }),
  // Pass-through (no fake timers in this suite): the anti-flicker is unit-tested
  // separately in useMcpServers.test; here `synced` should reflect the raw value.
  useDelayedFalse: (v: boolean) => v,
}));

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

// The secret picker reads the account vault through React Query; keep it
// empty and benign. (`formatApiErrorDetail` stays real — the inline submit-error
// copy is what the submit tests assert on.)
vi.mock('@/hooks/useUserVault', () => ({
  useUserVaultSecrets: () => ({ data: { secrets: [], remaining_slots: 10 }, isLoading: false, error: null }),
  useCreateUserVaultSecret: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

// Stub the row so its actions are plain buttons: the real Radix kebab needs
// portal/pointer machinery jsdom doesn't drive (the row's own test mocks the
// dropdown for the same reason). McpServerRow's item wiring is covered there.
vi.mock('../McpServerRow', () => ({
  McpServerRow: ({
    server,
    onSetupSecret,
    onEdit,
  }: {
    server: { name: string; missing_secrets: string[] };
    onSetupSecret: (name: string) => void;
    onEdit: (server: unknown) => void;
  }) => (
    <div data-testid={`row-${server.name}`}>
      <span>{server.name}</span>
      <button type="button" onClick={() => onEdit(server)}>{`edit-${server.name}`}</button>
      {server.missing_secrets.map((secret) => (
        <button key={secret} type="button" onClick={() => onSetupSecret(secret)}>
          {`setup-${secret}`}
        </button>
      ))}
    </div>
  ),
}));

import { McpTab } from '../McpTab';

function makeServer(name: string, overrides: Partial<EffectiveServer> = {}): EffectiveServer {
  return {
    name,
    origin: 'user',
    transport: 'stdio',
    enabled: true,
    editable: true,
    status: 'connected',
    error: '',
    tool_count: 0,
    tools: [],
    missing_secrets: [],
    env_refs: [],
    header_refs: [],
    description: '',
    instruction: '',
    tool_exposure_mode: 'summary',
    command: 'npx',
    args: [],
    url: null,
    config_version: 1,
    ...overrides,
  };
}

function makeList(servers: EffectiveServer[], maxServers = 20): EffectiveServerList {
  return { servers, sandbox_running: true, max_servers: maxServers, config_version: 1 };
}

/** Only the count reaches the tab, so the rows can stay bare. */
function makeCatalog(count: number, maxServers: number): CatalogServerList {
  return {
    servers: Array.from({ length: count }, (_, i) => ({ name: `s${i}` }) as CatalogServerList['servers'][number]),
    max_servers: maxServers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listData = makeList([]);
  catalogData = makeCatalog(0, 20);
});

describe('McpTab — submit error formatting', () => {
  it('renders FastAPI array-shaped validation detail as readable text (not [object Object])', async () => {
    // FastAPI 422 validation list — must be flattened, not stringified.
    mutateAsync.add.mockRejectedValue({
      response: {
        data: {
          detail: [
            { loc: ['body', 'url'], msg: 'field required', type: 'value_error.missing' },
          ],
        },
      },
    });

    renderWithProviders(<McpTab workspaceId="ws-1" />);

    // Open the add-server modal, give it a valid name, and submit.
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByTestId('mcp-entry'), { target: { value: 'npx -y @scope/thing' } });
    fireEvent.change(screen.getByPlaceholderText('my_server'), { target: { value: 'good_name' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    const expected = 'body.url: field required';
    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    // The flattened message must not collapse to the object placeholder.
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });
});

describe('McpTab: account servers', () => {
  it('holds Add and Import at the account cap, with the reason on each', () => {
    // The catalog counts servers switched off account-wide, which this
    // workspace's list leaves out, so a list of one can still be at the cap.
    listData = makeList([makeServer('a')], 3);
    catalogData = makeCatalog(3, 3);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    const reason = 'Your account is at its limit of 3 servers. Remove one in Plugins first.';
    for (const name of [/add server/i, /import json/i]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', reason);
    }
  });

  it('does not count this list against the cap, and shows a 409 in the form', async () => {
    // Two rows here against a cap of two is not a full account: the gate reads
    // the catalog, and a refusal it misses lands where the user is typing.
    listData = makeList([makeServer('a'), makeServer('b')], 2);
    catalogData = makeCatalog(2, 3);
    mutateAsync.add.mockRejectedValue({
      response: { status: 409, data: { detail: 'You already have a server named good_name.' } },
    });
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    expect(screen.getByText(/turns it on only in this workspace/i)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mcp-entry'), { target: { value: 'npx -y @scope/thing' } });
    fireEvent.change(screen.getByPlaceholderText('my_server'), { target: { value: 'good_name' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(screen.getByText('You already have a server named good_name.')).toBeInTheDocument(),
    );
  });

  it('sends "Set up NAME" to the account vault with the name prefilled', () => {
    listData = makeList([
      makeServer('needs', { status: 'needs_secret', missing_secrets: ['MY_API_KEY'] }),
    ]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    fireEvent.click(screen.getByText('setup-MY_API_KEY'));
    expect(navigate).toHaveBeenCalledWith('/plugins?tab=secrets&secret=MY_API_KEY');
  });

  it('names the account reach in the edit title and save label', () => {
    // The row sits in one workspace's list, but the edit rewrites the account
    // server every workspace reads, and the plain "Save" did not say so.
    listData = makeList([makeServer('shared')]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    fireEvent.click(screen.getByText('edit-shared'));
    expect(screen.getByText('Edit account server')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-submit')).toHaveTextContent('Save for all workspaces');
  });
});

describe('McpTab — auto-resolve pending servers', () => {
  it('probes a pending server once when the sandbox is running', async () => {
    listData = makeList([makeServer('pend', { status: 'pending' })]);
    mutateAsync.discover.mockResolvedValue({ status: 'connected', tools: [], error: '' });
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    // A fresh pending server shouldn't sit on a dead pill — it gets probed.
    await waitFor(() => expect(mutateAsync.discover).toHaveBeenCalledWith('pend'));
    expect(mutateAsync.discover).toHaveBeenCalledTimes(1);
  });

  it('does NOT probe when the sandbox is stopped (nothing to discover against)', async () => {
    listData = { ...makeList([makeServer('pend', { status: 'pending' })]), sandbox_running: false };
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByTestId('row-pend')).toBeInTheDocument());
    expect(mutateAsync.discover).not.toHaveBeenCalled();
  });

  it('does NOT probe a disabled pending server (it reads as Disabled)', async () => {
    listData = makeList([makeServer('off', { status: 'pending', enabled: false })]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByTestId('row-off')).toBeInTheDocument());
    expect(mutateAsync.discover).not.toHaveBeenCalled();
  });

  it('does NOT probe an OAuth row — discovery is host-side and the backend 409s', async () => {
    // The gate that keeps this and the list query's self-stopping poll in
    // agreement: probing here would 409, and counting it there would poll
    // forever on a server no probe can ever resolve.
    listData = makeList([
      makeServer('oauth_row', { origin: 'user', status: 'pending', oauth_status: 'connected' }),
    ]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByTestId('row-oauth_row')).toBeInTheDocument());
    expect(mutateAsync.discover).not.toHaveBeenCalled();
  });

  it('does NOT probe a builtin (always connected, process-global)', async () => {
    listData = makeList([makeServer('builtin_row', { origin: 'builtin', status: 'pending' })]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByTestId('row-builtin_row')).toBeInTheDocument());
    expect(mutateAsync.discover).not.toHaveBeenCalled();
  });

  it('does NOT re-probe a connected server', async () => {
    listData = makeList([makeServer('ok', { status: 'connected' })]);
    renderWithProviders(<McpTab workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByTestId('row-ok')).toBeInTheDocument());
    expect(mutateAsync.discover).not.toHaveBeenCalled();
  });
});
