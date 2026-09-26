/**
 * The vault's "set up this secret" deep link: `?tab=secrets&secret=NAME` opens
 * the add form prefilled with NAME. A URL param for the same reason as the Add
 * intent (`addParam.ts`): the Secrets tab strips it once acted on, so a remount
 * does not reopen the form, and it works from any page, including the
 * workspace MCP tab's "Set up NAME" button.
 */

export const SECRET_PARAM = 'secret';

export function secretSetupHref(name: string): string {
  const params = new URLSearchParams({ tab: 'secrets', [SECRET_PARAM]: name });
  return `/plugins?${params.toString()}`;
}
