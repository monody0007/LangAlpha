import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, Check, ChevronDown, FolderOpen, Globe, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';

/**
 * The scope control on a Plugins row: where a skill / MCP server lives and
 * where it is active. Shared by the Skills and MCP tabs.
 *
 * Tier is a property (all workspaces vs one workspace) changed only by an
 * explicit Move action. The per-workspace checklist on an all-workspaces row
 * drives the deny-list (per-workspace disables / tombstones) and deliberately
 * never changes tier. A checklist switch changes today's workspaces only:
 * what a workspace created later starts with is the row's own setting where
 * it has one (a user MCP server, "On in new workspaces"), and on for
 * everything else.
 */

export interface ScopeWorkspace {
  id: string;
  name: string;
}

/**
 * Whether a row's checklist has to lock, from its *effective* state.
 *
 * A workspace can add a deny-marker for anything, but removing one goes
 * through a re-enable that 409s whenever the account tier already subtracts
 * the row -- by its own switch, or by the package that ships it being off.
 * Reading only `enabled` leaves an interactive control that can make a change
 * it cannot take back, so the two conditions live together here rather than
 * being restated at each call site, where one of them kept being forgotten.
 */
export function scopeLocked(row: {
  enabled?: boolean | null;
  plugin_enabled?: boolean | null;
}): boolean {
  return !row.enabled || row.plugin_enabled === false;
}

export type ScopeReach =
  | { kind: 'all' }
  | { kind: 'allExcept'; count: number }
  | { kind: 'none' }
  | { kind: 'only'; name: string }
  | { kind: 'some'; count: number };

/**
 * Where a user-tier row is on, as the badge and the row's state line both say
 * it. A row new workspaces start with reads as the deny-list it is: all
 * workspaces, less the ones that switched it off. A row they start without
 * reads as the list of workspaces it is actually on in, Flash included when
 * the checklist offers it, because "All workspaces" there would promise the
 * next workspace a server it will not have. `undefined` is a backend that
 * predates the setting, where every row still inherited.
 */
export function scopeReach(
  workspaces: ScopeWorkspace[],
  disabledWorkspaceIds: string[] = [],
  flashWorkspace?: ScopeWorkspace,
  newWorkspacesOn?: boolean,
): ScopeReach {
  return readChecklist(workspaces, disabledWorkspaceIds, flashWorkspace, newWorkspacesOn).reach;
}

/**
 * The checklist a user-tier row offers, the workspaces in it that switched the
 * row off, and the reach that follows, in one pass so the badge, the state
 * line and the menu cannot read them differently. Only listed workspaces
 * count as off: a stale disable for a deleted one would otherwise inflate
 * "except N".
 */
function readChecklist(
  workspaces: ScopeWorkspace[],
  disabledWorkspaceIds: string[] = [],
  flashWorkspace?: ScopeWorkspace,
  newWorkspacesOn?: boolean,
): { checklist: ScopeWorkspace[]; disabled: ReadonlySet<string>; reach: ScopeReach } {
  const checklist = flashWorkspace ? [...workspaces, flashWorkspace] : workspaces;
  const disabled = new Set(disabledWorkspaceIds);
  const active = checklist.filter((w) => !disabled.has(w.id));
  const off = checklist.length - active.length;
  let reach: ScopeReach;
  if (newWorkspacesOn !== false) {
    reach = off > 0 ? { kind: 'allExcept', count: off } : { kind: 'all' };
  } else if (active.length === 0) {
    reach = { kind: 'none' };
  } else if (active.length === 1) {
    reach = { kind: 'only', name: active[0].name };
  } else {
    reach = { kind: 'some', count: active.length };
  }
  return { checklist, disabled, reach };
}

/** A user server row's state line, worded off the same reach as its badge. */
export function serverStateLine(t: TFunction, enabled: boolean, reach: ScopeReach): string {
  if (!enabled) return t('plugins.servers.disabledState');
  switch (reach.kind) {
    case 'all':
      return t('plugins.servers.enabledState');
    case 'allExcept':
      return t('plugins.servers.enabledExceptState', { count: reach.count });
    case 'none':
      return t('plugins.servers.enabledNowhereState');
    case 'only':
      return t('plugins.servers.enabledOnlyInState', { name: reach.name });
    case 'some':
      return t('plugins.servers.enabledInState', { count: reach.count });
  }
}

function reachLabel(t: TFunction, reach: ScopeReach): string {
  switch (reach.kind) {
    case 'all':
      return t('plugins.scope.allWorkspaces');
    case 'allExcept':
      return t('plugins.scope.allExcept', { count: reach.count });
    case 'none':
      return t('plugins.scope.noWorkspaces');
    case 'only':
      return t('plugins.scope.onlyIn', { name: reach.name });
    case 'some':
      return t('plugins.scope.someWorkspaces', { count: reach.count });
  }
}

export function ScopeControl({
  workspaces,
  scopeWorkspaceId,
  disabledWorkspaceIds = [],
  checklistLocked = false,
  moveBlockedReason = null,
  moveToAllBlockedReason = null,
  busy = false,
  flashWorkspace,
  newWorkspacesOn,
  loading = false,
  onSetWorkspaceDisabled,
  onSetNewWorkspacesOn,
  onMove,
}: {
  workspaces: ScopeWorkspace[];
  /** null = all-workspaces tier; a workspace id = scoped to that workspace. */
  scopeWorkspaceId: string | null;
  disabledWorkspaceIds?: string[];
  /** Lock the checklist, e.g. when the row itself is disabled account-wide
   * (a workspace re-enable would 409 against the asymmetry rule). */
  checklistLocked?: boolean;
  /** Shown instead of the move actions (e.g. a plugin-owned skill, which
   * stays at the account level with its package). */
  moveBlockedReason?: string | null;
  /** Blocks only the move-to-all-workspaces destination (e.g. a shadowing
   * row whose name is known to collide there); workspace targets stay
   * offered. */
  moveToAllBlockedReason?: string | null;
  busy?: boolean;
  /** Adds the Flash workspace to the checklist, and to nothing else. Only an
   * MCP server with directly bound tools is reachable from Flash, so rows that
   * cannot have any leave this unset. */
  flashWorkspace?: ScopeWorkspace;
  /** What a workspace created later starts with, on rows that have their own
   * setting. `false` also switches the badge from the deny-list wording to
   * the workspaces the row is on in. */
  newWorkspacesOn?: boolean;
  /** `workspaces` has not arrived yet: the pill waits rather than name a reach
   * counted against an empty list. */
  loading?: boolean;
  onSetWorkspaceDisabled?: (workspaceId: string, disabled: boolean) => void;
  /** Offers "On in new workspaces" in place of the static hint. Rows whose
   * new workspaces always start on (builtins, skills) leave this unset. */
  onSetNewWorkspacesOn?: (on: boolean) => void;
  onMove?: (toWorkspaceId: string | null) => void;
}) {
  const { t } = useTranslation();
  if (loading) return null;
  const isUserTier = scopeWorkspaceId === null;
  const scopeWorkspace = workspaces.find((w) => w.id === scopeWorkspaceId);
  const { checklist, disabled, reach } = readChecklist(
    workspaces,
    disabledWorkspaceIds,
    flashWorkspace,
    newWorkspacesOn,
  );
  const inherits = reach.kind === 'all' || reach.kind === 'allExcept';

  const label = isUserTier
    ? reachLabel(t, reach)
    : scopeWorkspace?.name ?? t('plugins.scope.unknownWorkspace');
  const Icon = isUserTier && inherits ? Globe : FolderOpen;
  // Only a label that carries a workspace name can outgrow the pill, so only
  // that one needs the full text on hover.
  const labelTitle = isUserTier && reach.kind !== 'only' ? undefined : label;

  const hasChecklist =
    isUserTier && !!onSetWorkspaceDisabled && checklist.length > 0;
  // Not gated on the checklist: with no workspace yet to list, what the next
  // one starts with is the only scope a row has.
  const hasNewWorkspaces = isUserTier && !!onSetNewWorkspacesOn;
  const newOn = newWorkspacesOn !== false;
  const moveTargets = workspaces.filter((w) => w.id !== scopeWorkspaceId);
  const hasMove =
    !!onMove &&
    (moveBlockedReason !== null || !isUserTier || moveTargets.length > 0);

  const badge = (
    <span
      title={labelTitle}
      className="inline-flex items-center gap-1 px-2 py-1 text-[0.6875rem] rounded-md whitespace-nowrap max-w-[12rem]"
      style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-muted)' }}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );

  if (!hasChecklist && !hasNewWorkspaces && !hasMove) return badge;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={t('plugins.scope.triggerAria', { scope: label })}
          title={labelTitle}
          className="inline-flex items-center gap-1 px-2 py-1 text-[0.6875rem] rounded-md transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50 disabled:hover:bg-transparent whitespace-nowrap max-w-[12rem]"
          style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-muted)' }}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {hasChecklist && (
          <>
            <DropdownMenuLabel>{t('plugins.scope.activeIn')}</DropdownMenuLabel>
            {checklist.map((ws) => {
              const active = !disabled.has(ws.id);
              return (
                <DropdownMenuCheckboxItem
                  key={ws.id}
                  checked={active}
                  disabled={checklistLocked || busy}
                  onSelect={(e) => {
                    // Keep the menu open: the checklist is a multi-toggle.
                    e.preventDefault();
                    onSetWorkspaceDisabled?.(ws.id, active);
                  }}
                >
                  <Check
                    className="h-3.5 w-3.5 mr-2"
                    style={{ opacity: active ? 1 : 0 }}
                  />
                  {ws === flashWorkspace ? (
                    <Zap className="h-3.5 w-3.5 mr-1.5 shrink-0" />
                  ) : null}
                  <span className="truncate">{ws.name}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
            {flashWorkspace && (
              <DropdownMenuLabel
                className="font-normal pt-0 max-w-[16rem] whitespace-normal"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                {t('plugins.scope.flashNote')}
              </DropdownMenuLabel>
            )}
            {!hasNewWorkspaces && (
              <DropdownMenuLabel
                className="font-normal"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                {t('plugins.scope.futureHint')}
              </DropdownMenuLabel>
            )}
          </>
        )}
        {hasNewWorkspaces && (
          <>
            {/* Apart from the checklist: it is not a workspace, and a flip
                here changes none of the ones listed above. */}
            {hasChecklist && <DropdownMenuSeparator />}
            <DropdownMenuCheckboxItem
              checked={newOn}
              // Not held by `checklistLocked`: the setting is stored on the
              // row and no workspace re-enable is involved, so nothing 409s.
              disabled={busy}
              onSelect={(e) => {
                // Keep the menu open, as the checklist does.
                e.preventDefault();
                onSetNewWorkspacesOn?.(!newOn);
              }}
            >
              <Check className="h-3.5 w-3.5 mr-2" style={{ opacity: newOn ? 1 : 0 }} />
              <span>{t('plugins.scope.newWorkspacesOn')}</span>
            </DropdownMenuCheckboxItem>
          </>
        )}
        {(hasChecklist || hasNewWorkspaces) && hasMove && <DropdownMenuSeparator />}
        {hasMove && moveBlockedReason !== null ? (
          <DropdownMenuItem disabled>
            <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
            <span className="max-w-[16rem] whitespace-normal">
              {moveBlockedReason}
            </span>
          </DropdownMenuItem>
        ) : hasMove ? (
          <>
            {!isUserTier &&
              (moveToAllBlockedReason !== null ? (
                <DropdownMenuItem disabled>
                  <Globe className="h-3.5 w-3.5 mr-2" />
                  <span className="max-w-[16rem] whitespace-normal">
                    {moveToAllBlockedReason}
                  </span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled={busy} onSelect={() => onMove?.(null)}>
                  <Globe className="h-3.5 w-3.5 mr-2" />
                  {t('plugins.scope.moveToAll')}
                </DropdownMenuItem>
              ))}
            {moveTargets.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
                  {isUserTier
                    ? t('plugins.scope.moveToWorkspace')
                    : t('plugins.scope.moveToAnother')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {moveTargets.map((ws) => (
                    <DropdownMenuItem
                      key={ws.id}
                      disabled={busy}
                      onSelect={() => onMove?.(ws.id)}
                    >
                      <span className="truncate">{ws.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
