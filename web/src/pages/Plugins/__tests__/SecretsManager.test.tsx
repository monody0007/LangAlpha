import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/test/utils';

/**
 * `SecretsManager` driven through its one adapter, Plugins → Secrets (React
 * Query mutations). Every branch below is exercised through that adapter
 * rather than through hand-passed props, because the interesting failures live
 * in the wiring: a mutation shape the component doesn't call the way the
 * adapter expects, or a rejection the adapter swallows before the shared error
 * region can render it.
 */

// ---------------------------------------------------------------------------
// Hook boundary — the user (Plugins) adapter
// ---------------------------------------------------------------------------

const userVault = {
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
};

interface UserVaultData {
  secrets: Array<{
    user_vault_secret_id: string;
    name: string;
    description: string;
    masked_value: string;
    created_at: string;
    updated_at: string;
  }>;
  remaining_slots: number;
}

let userVaultData: UserVaultData | undefined;
let userVaultError: Error | null = null;
let userVaultLoading = false;

let userBlueprints: Array<{
  name: string;
  label: string;
  description?: string;
  docs_url?: string | null;
  regex?: string | null;
}> = [];

vi.mock('@/hooks/useUserVault', () => ({
  useUserVaultSecrets: () => ({ data: userVaultData, isLoading: userVaultLoading, error: userVaultError }),
  useUserVaultBlueprints: () => ({ data: { blueprints: userBlueprints, remaining_slots: 20 } }),
  useCreateUserVaultSecret: () => ({ mutateAsync: userVault.create, isPending: false }),
  useUpdateUserVaultSecret: () => ({ mutateAsync: userVault.update, isPending: false }),
  useDeleteUserVaultSecret: () => ({ mutateAsync: userVault.del, isPending: false }),
}));

// ---------------------------------------------------------------------------
// API boundary: the one direct call the adapter makes (`revealUserVaultSecret`).
// ---------------------------------------------------------------------------

const mockRevealUserVaultSecret = vi.fn();

vi.mock('@/pages/ChatAgent/utils/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // `formatApiErrorDetail` stays real — the error copy is what's under test.
    revealUserVaultSecret: (...a: unknown[]) => mockRevealUserVaultSecret(...a),
  };
});

// The real api module is imported (for `formatApiErrorDetail`), and its
// transport layer reads `api.defaults.baseURL` at module scope — so the stub
// needs that shape, not just the verbs.
vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    defaults: { baseURL: '' },
  },
}));

import { PluginSecrets } from '../components/PluginSecrets';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userSecret(name: string, overrides: Partial<UserVaultData['secrets'][number]> = {}) {
  return {
    user_vault_secret_id: `uvs-${name}`,
    name,
    description: '',
    masked_value: 'sk-…abcd',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  userVaultData = { secrets: [], remaining_slots: 20 };
  userVaultError = null;
  userVaultLoading = false;
  userBlueprints = [];
});

// ===========================================================================
// User adapter — Plugins → Secrets (React Query mutations)
// ===========================================================================

describe('SecretsManager via the user vault adapter — list', () => {
  it('renders each secret with its masked value and description', () => {
    userVaultData = {
      secrets: [
        userSecret('ALPHA_TOKEN', { description: 'used by the alpha connector' }),
        userSecret('BETA_TOKEN'),
      ],
      remaining_slots: 18,
    };
    renderWithProviders(<PluginSecrets />);

    expect(screen.getByText('ALPHA_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('BETA_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('used by the alpha connector')).toBeInTheDocument();
    expect(screen.getAllByText('sk-…abcd')).toHaveLength(2);
    // The count line reflects secrets + remaining slots, not a hardcoded cap.
    expect(screen.getByText('2 / 20')).toBeInTheDocument();
  });

  it('shows the user-scope empty state and hint', () => {
    renderWithProviders(<PluginSecrets />);
    expect(screen.getByText(/No secrets stored. Add API keys or credentials for your servers/i)).toBeInTheDocument();
    expect(screen.getByText(/available in every workspace/i)).toBeInTheDocument();
  });

  it('surfaces a load failure', () => {
    userVaultError = new Error('vault unreachable');
    renderWithProviders(<PluginSecrets />);
    expect(screen.getByText('vault unreachable')).toBeInTheDocument();
  });

  it('renders the skeleton while loading, not an empty list', () => {
    userVaultLoading = true;
    userVaultData = undefined;
    renderWithProviders(<PluginSecrets />);
    expect(screen.queryByText(/No secrets stored/i)).not.toBeInTheDocument();
  });

  it('hides Add Secret at the cap', () => {
    userVaultData = { secrets: [userSecret('ONLY_TOKEN')], remaining_slots: 0 };
    renderWithProviders(<PluginSecrets />);
    expect(screen.queryByRole('button', { name: /add secret/i })).not.toBeInTheDocument();
  });
});

describe('SecretsManager via the user vault adapter — create', () => {
  it('creates through the mutation and closes the form', async () => {
    userVault.create.mockResolvedValue({ name: 'NEW_TOKEN' });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.change(screen.getByPlaceholderText('SECRET_NAME'), { target: { value: 'NEW_TOKEN' } });
    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'placeholder-value' } });
    fireEvent.change(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'for testing' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(userVault.create).toHaveBeenCalledWith({
        name: 'NEW_TOKEN', value: 'placeholder-value', description: 'for testing',
      }),
    );
    await waitFor(() => expect(screen.queryByPlaceholderText('Secret value')).not.toBeInTheDocument());
  });

  it('normalizes the typed name so the mutation only ever sees a legal one', async () => {
    // The name field is the guard: it upper-cases, maps anything outside
    // [A-Z0-9_] to `_`, and strips leading digits, so what reaches `onCreate`
    // always satisfies the backend's name rule. Illegal characters become `_`
    // rather than vanishing, which is what lets a hand-typed name reproduce
    // the name suggested beside a header row (one shared helper does both).
    // (`vault.nameInvalid` still backstops the prefill deep-link, which sets
    // the name without passing through here.)
    userVault.create.mockResolvedValue({ name: 'BAD_NAME_' });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    const nameInput = screen.getByPlaceholderText('SECRET_NAME');
    fireEvent.change(nameInput, { target: { value: '9bad-name!' } });
    expect((nameInput as HTMLInputElement).value).toBe('BAD_NAME_');

    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(userVault.create).toHaveBeenCalledWith({ name: 'BAD_NAME_', value: 'x', description: undefined }),
    );
  });

  it('keeps Save disabled until both a name and a value are present', () => {
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('SECRET_NAME'), { target: { value: 'NAME_ONLY' } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'v' } });
    expect(save).not.toBeDisabled();
    expect(userVault.create).not.toHaveBeenCalled();
  });

  it('surfaces a rejected create and keeps the form open', async () => {
    userVault.create.mockRejectedValue({ response: { data: { detail: 'name already taken' } } });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.change(screen.getByPlaceholderText('SECRET_NAME'), { target: { value: 'DUP_TOKEN' } });
    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('name already taken')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('Secret value')).toBeInTheDocument();
  });
});

describe('SecretsManager via the user vault adapter — update', () => {
  it('sends the adapter-shaped { name, body } payload', async () => {
    userVaultData = { secrets: [userSecret('EDIT_TOKEN', { description: 'old' })], remaining_slots: 19 };
    userVault.update.mockResolvedValue({ name: 'EDIT_TOKEN' });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.change(screen.getByPlaceholderText('New value (leave empty to keep current)'), {
      target: { value: 'rotated-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));

    await waitFor(() =>
      expect(userVault.update).toHaveBeenCalledWith({
        name: 'EDIT_TOKEN',
        body: { value: 'rotated-value', description: 'old' },
      }),
    );
  });

  it('omits the value entirely when only the description changed', async () => {
    userVaultData = { secrets: [userSecret('EDIT_TOKEN', { description: 'old' })], remaining_slots: 19 };
    userVault.update.mockResolvedValue({ name: 'EDIT_TOKEN' });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.change(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'new note' } });
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));

    await waitFor(() =>
      expect(userVault.update).toHaveBeenCalledWith({ name: 'EDIT_TOKEN', body: { description: 'new note' } }),
    );
  });

  it('surfaces a rejected update', async () => {
    userVaultData = { secrets: [userSecret('EDIT_TOKEN')], remaining_slots: 19 };
    userVault.update.mockRejectedValue({ response: { data: { detail: 'value too long' } } });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));

    await waitFor(() => expect(screen.getByText('value too long')).toBeInTheDocument());
  });
});

describe('SecretsManager via the user vault adapter — delete', () => {
  it('requires the inline confirm before deleting', async () => {
    userVaultData = { secrets: [userSecret('DOOMED_TOKEN')], remaining_slots: 19 };
    userVault.del.mockResolvedValue({ ok: true });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Delete'));
    expect(userVault.del).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(userVault.del).toHaveBeenCalledWith('DOOMED_TOKEN'));
  });

  it('cancels the confirm without deleting', () => {
    userVaultData = { secrets: [userSecret('DOOMED_TOKEN')], remaining_slots: 19 };
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument();
    expect(userVault.del).not.toHaveBeenCalled();
  });

  it('surfaces a rejected delete instead of silently dismissing the confirm', async () => {
    userVaultData = { secrets: [userSecret('DOOMED_TOKEN')], remaining_slots: 19 };
    userVault.del.mockRejectedValue({ response: { data: { detail: 'referenced by a live server' } } });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByText('referenced by a live server')).toBeInTheDocument());
    // Still armed — the user can retry or back out.
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument();
  });
});

describe('SecretsManager via the user vault adapter — reveal', () => {
  it('fetches the value on reveal and hides it again on the second click', async () => {
    userVaultData = { secrets: [userSecret('SHOW_TOKEN')], remaining_slots: 19 };
    mockRevealUserVaultSecret.mockResolvedValue('placeholder-plaintext');
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Reveal value'));

    await waitFor(() => expect(mockRevealUserVaultSecret).toHaveBeenCalledWith('SHOW_TOKEN'));
    await waitFor(() => expect(screen.getByText('placeholder-plaintext')).toBeInTheDocument());
    expect(screen.queryByText('sk-…abcd')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Hide value'));
    await waitFor(() => expect(screen.getByText('sk-…abcd')).toBeInTheDocument());
    // Hiding is local state — no second round trip.
    expect(mockRevealUserVaultSecret).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected reveal and keeps the value masked', async () => {
    userVaultData = { secrets: [userSecret('SHOW_TOKEN')], remaining_slots: 19 };
    mockRevealUserVaultSecret.mockRejectedValue({ response: { data: { detail: 'decrypt failed' } } });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Reveal value'));

    await waitFor(() => expect(screen.getByText('decrypt failed')).toBeInTheDocument());
    expect(screen.getByText('sk-…abcd')).toBeInTheDocument();
  });

  it('discards a reveal that resolves after the secret was deleted', async () => {
    // The reveal cache is keyed by name: if a slow reveal resolved after the
    // delete and still cached, a recreated same-name secret would display the
    // deleted one's plaintext.
    userVaultData = { secrets: [userSecret('RACE_TOKEN')], remaining_slots: 19 };
    let resolveReveal!: (value: string) => void;
    mockRevealUserVaultSecret.mockImplementation(
      () => new Promise<string>((resolve) => { resolveReveal = resolve; }),
    );
    userVault.del.mockResolvedValue({ ok: true });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Reveal value'));
    await waitFor(() => expect(mockRevealUserVaultSecret).toHaveBeenCalledWith('RACE_TOKEN'));

    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(userVault.del).toHaveBeenCalledWith('RACE_TOKEN'));

    await act(async () => { resolveReveal('stale-plaintext'); });

    expect(screen.queryByText('stale-plaintext')).not.toBeInTheDocument();
    expect(screen.getByText('sk-…abcd')).toBeInTheDocument();
  });

  it('discards a reveal that resolves after the secret was updated', async () => {
    // The delete fence alone is not enough: an edit+save racing a slow reveal
    // would otherwise repopulate the UI with the pre-edit plaintext.
    userVaultData = { secrets: [userSecret('RACE_TOKEN')], remaining_slots: 19 };
    let resolveReveal!: (value: string) => void;
    mockRevealUserVaultSecret.mockImplementation(
      () => new Promise<string>((resolve) => { resolveReveal = resolve; }),
    );
    userVault.update.mockResolvedValue({ name: 'RACE_TOKEN' });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Reveal value'));
    await waitFor(() => expect(mockRevealUserVaultSecret).toHaveBeenCalledWith('RACE_TOKEN'));

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.change(screen.getByPlaceholderText('New value (leave empty to keep current)'), {
      target: { value: 'rotated-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));
    await waitFor(() => expect(userVault.update).toHaveBeenCalled());

    await act(async () => { resolveReveal('pre-edit-plaintext'); });

    expect(screen.queryByText('pre-edit-plaintext')).not.toBeInTheDocument();
    expect(screen.getByText('sk-…abcd')).toBeInTheDocument();
  });
});

describe('SecretsManager via the user vault adapter: edit and deep link', () => {
  it('opens an edit form scoped to the clicked row', () => {
    userVaultData = {
      secrets: [userSecret('FIRST_TOKEN'), userSecret('SECOND_TOKEN')],
      remaining_slots: 18,
    };
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getAllByTitle('Edit')[1]);
    expect(screen.getByPlaceholderText('New value (leave empty to keep current)')).toBeInTheDocument();
    expect(screen.getByText('FIRST_TOKEN')).toBeInTheDocument();
  });

  it('opens the add form prefilled from a "Set up NAME" link, once', async () => {
    // The workspace MCP tab links here for a missing secret; the param is
    // stripped once acted on, so a remount does not reopen the form.
    function Search() {
      return <span data-testid="search">{useLocation().search}</span>;
    }
    renderWithProviders(
      <>
        <PluginSecrets />
        <Search />
      </>,
      { route: '/plugins?tab=secrets&secret=MY_API_KEY' },
    );

    expect(screen.getByPlaceholderText('SECRET_NAME')).toHaveValue('MY_API_KEY');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?tab=secrets'));
    expect(screen.getByTestId('search')).not.toHaveTextContent('secret=');
  });

  it('explains how sandbox code reads a secret', () => {
    renderWithProviders(<PluginSecrets />);
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });
});

describe('SecretsManager via the user vault adapter: recommended credentials', () => {
  const X_BLUEPRINT = {
    name: 'X_BEARER_TOKEN',
    label: 'X (Twitter) Bearer Token',
    description: 'Read-only app-only auth for x_api.',
    docs_url: 'https://console.x.com/',
    regex: '^[A-Za-z0-9%_-]{20,}$',
  };

  it('opens the add form prefilled, with the docs link', () => {
    userBlueprints = [X_BLUEPRINT];
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByText('Set up'));
    expect(screen.getByPlaceholderText('SECRET_NAME')).toHaveValue('X_BEARER_TOKEN');
    expect(screen.getByText('Docs').closest('a')).toHaveAttribute('href', 'https://console.x.com/');
  });

  it('disables Set up at the cap', () => {
    userBlueprints = [X_BLUEPRINT];
    userVaultData = { secrets: [userSecret('ONLY_TOKEN')], remaining_slots: 0 };
    renderWithProviders(<PluginSecrets />);
    expect(screen.getByText('Set up').closest('button')).toBeDisabled();
  });

  it('hints when the value does not match the blueprint regex, and not when it does', async () => {
    userBlueprints = [X_BLUEPRINT];
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getByText('Set up'));

    const value = screen.getByPlaceholderText('Secret value');
    fireEvent.change(value, { target: { value: 'Bearer abc' } });
    await waitFor(() => expect(screen.getByText(/doesn't look like a valid/i)).toBeInTheDocument());

    fireEvent.change(value, { target: { value: 'A'.repeat(25) } });
    await waitFor(() =>
      expect(screen.queryByText(/doesn't look like a valid/i)).not.toBeInTheDocument(),
    );
  });

  it('survives a malformed blueprint regex', () => {
    userBlueprints = [{ ...X_BLUEPRINT, regex: '[unterminated' }];
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getByText('Set up'));

    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'anything' } });
    expect(screen.queryByText(/doesn't look like a valid/i)).not.toBeInTheDocument();
  });
});

// ===========================================================================
// The add form as a disclosure: the button that opens it, the labels on it,
// the keystroke that closes it, and what stays on screen beside it.
// ===========================================================================

describe('SecretsManager: the add form opens as a disclosure', () => {
  it('turns the Add Secret button into the form\'s cancel while it is open', () => {
    renderWithProviders(<PluginSecrets />);

    const add = screen.getByRole('button', { name: /add secret/i });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);

    expect(screen.queryByRole('button', { name: /add secret/i })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { expanded: true });
    expect(toggle).toHaveTextContent(/cancel/i);
    // It points at the region it opened, so a screen reader can follow it there.
    const region = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(region).toContainElement(screen.getByPlaceholderText('SECRET_NAME'));
  });

  it('closes again from the same button', async () => {
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.click(screen.getByRole('button', { expanded: true }));

    await waitFor(() => expect(screen.queryByPlaceholderText('SECRET_NAME')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /add secret/i })).toBeInTheDocument();
  });

  it('names every field above it, not only inside it', () => {
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));

    expect(screen.getByLabelText('Name')).toBe(screen.getByPlaceholderText('SECRET_NAME'));
    expect(screen.getByLabelText('Value')).toBe(screen.getByPlaceholderText('Secret value'));
    expect(screen.getByLabelText('Description')).toBe(
      screen.getByPlaceholderText('Description (optional)'),
    );
  });

  it('closes on Escape from inside the form', async () => {
    renderWithProviders(<PluginSecrets />);
    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.keyDown(screen.getByPlaceholderText('SECRET_NAME'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByPlaceholderText('SECRET_NAME')).not.toBeInTheDocument());
    expect(userVault.create).not.toHaveBeenCalled();
  });

  it('ignores Escape while the save is in flight', async () => {
    // Backing out of a form whose create is already on the wire would leave
    // the user with no sight of how it landed.
    userVault.create.mockImplementation(() => new Promise(() => {}));
    // The file's beforeEach only clears calls, which keeps implementations, so
    // a create that never settles would be the one every later test gets.
    onTestFinished(() => {
      userVault.create.mockReset();
    });
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.change(screen.getByPlaceholderText('SECRET_NAME'), { target: { value: 'SLOW_TOKEN' } });
    fireEvent.change(screen.getByPlaceholderText('Secret value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(userVault.create).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByPlaceholderText('SECRET_NAME'), { key: 'Escape' });

    expect(screen.getByPlaceholderText('SECRET_NAME')).toBeInTheDocument();
  });

  it('keeps the recommended credentials on screen while the form is open', () => {
    // The cards are what tell the user which name the server is looking for.
    userBlueprints = [{ name: 'ACME_API_KEY', label: 'Acme API key' }];
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByText('Set up'));

    expect(screen.getByText('Recommended credentials')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('SECRET_NAME')).toHaveValue('ACME_API_KEY');
  });
});

describe('SecretsManager: the edit form opens as a disclosure', () => {
  it('closes on Escape without sending an update', async () => {
    userVaultData = { secrets: [userSecret('EDIT_TOKEN')], remaining_slots: 19 };
    renderWithProviders(<PluginSecrets />);

    fireEvent.click(screen.getByTitle('Edit'));
    const value = screen.getByPlaceholderText('New value (leave empty to keep current)');
    expect(screen.getByLabelText('New value')).toBe(value);
    fireEvent.keyDown(value, { key: 'Escape' });

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText('New value (leave empty to keep current)'),
      ).not.toBeInTheDocument(),
    );
    expect(userVault.update).not.toHaveBeenCalled();
  });
});
