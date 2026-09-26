import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useUserVaultSecrets,
  useUserVaultBlueprints,
  useCreateUserVaultSecret,
  useUpdateUserVaultSecret,
  useDeleteUserVaultSecret,
} from '@/hooks/useUserVault';
import { SecretsManager } from '@/pages/ChatAgent/components/vault/SecretsManager';
import { VaultUsageNote } from '@/pages/ChatAgent/components/vault/VaultUsageNote';
import { revealUserVaultSecret } from '@/pages/ChatAgent/utils/api';
import { SECRET_PARAM } from '../utils/secretParam';

/**
 * The Plugins → Secrets tab: the account vault. These secrets back
 * `${vault:NAME}` refs on the account's MCP servers and reach sandbox code in
 * every workspace.
 */

export function PluginSecrets() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, error: loadError } = useUserVaultSecrets();
  const { data: blueprintData } = useUserVaultBlueprints();
  const createMutation = useCreateUserVaultSecret();
  const updateMutation = useUpdateUserVaultSecret();
  const deleteMutation = useDeleteUserVaultSecret();

  const prefillSecretName = searchParams.get(SECRET_PARAM);
  const consumePrefill = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(SECRET_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const secrets = data?.secrets ?? [];
  const maxSecrets = secrets.length + (data?.remaining_slots ?? 0);

  return (
    <SecretsManager
      title={t('plugins.secrets.title')}
      blueprints={blueprintData?.blueprints ?? []}
      secrets={secrets.map((s) => ({
        id: s.user_vault_secret_id,
        name: s.name,
        description: s.description,
        masked_value: s.masked_value,
      }))}
      maxSecrets={maxSecrets}
      loading={isLoading}
      loadError={loadError ? (loadError as { message?: string })?.message || t('vault.loadFailed') : null}
      hint={t('plugins.secrets.scopeHint')}
      emptyText={t('plugins.secrets.empty')}
      prefillSecretName={prefillSecretName}
      onPrefillConsumed={consumePrefill}
      onCreate={(body) => createMutation.mutateAsync(body)}
      onUpdate={(name, body) => updateMutation.mutateAsync({ name, body })}
      onDelete={(name) => deleteMutation.mutateAsync(name)}
      onReveal={(name) => revealUserVaultSecret(name)}
      footer={<VaultUsageNote />}
    />
  );
}
