import { Trans, useTranslation } from 'react-i18next';

const CODE = <code className="font-mono" style={{ color: 'var(--color-text-secondary)' }} />;

/** Usage + security explainer under the vault list: how sandbox code reads a
 *  secret, and what keeps the value away from the model. Each sentence is one
 *  key with its code inline, so each locale sets the spacing around it. */
export function VaultUsageNote() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col gap-2.5 text-xs p-3 rounded-lg mt-1"
      style={{ backgroundColor: 'var(--color-bg-card)', color: 'var(--color-text-tertiary)' }}
    >
      <div>
        <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('vault.usage.title')}</span>
        <div className="mt-1">
          <Trans
            i18nKey="vault.usage.access"
            values={{ snippet: 'from vault import get; key = get("SECRET_NAME")' }}
            components={{ code: CODE }}
          />
        </div>
      </div>
      <div
        className="pt-2 flex flex-col gap-1.5"
        style={{ borderTop: '1px solid var(--color-border-muted)' }}
      >
        <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('vault.security.title')}</span>
        <ul className="flex flex-col gap-1 pl-3" style={{ listStyleType: 'disc' }}>
          <li>{t('vault.security.encrypted')}</li>
          <li>
            <Trans i18nKey="vault.security.agent" values={{ call: 'vault.get()' }} components={{ code: CODE }} />
          </li>
          <li>{t('vault.security.leakScan')}</li>
          <li>
            <Trans i18nKey="vault.security.store" values={{ module: 'vault' }} components={{ code: CODE }} />
          </li>
        </ul>
      </div>
    </div>
  );
}
