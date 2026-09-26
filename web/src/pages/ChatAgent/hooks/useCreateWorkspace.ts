/**
 * Create a workspace and refresh the lists that show it. The gallery and the
 * sidebar both open the create modal, and both hand it this.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { Workspace } from '@/types/api';

import { createWorkspace } from '../utils/api';
import { invalidateNewWorkspace } from './workspaceRowActions';

export interface NewWorkspace {
  name: string;
  description: string;
}

export function useCreateWorkspace(): (data: NewWorkspace) => Promise<Workspace> {
  const queryClient = useQueryClient();
  return useCallback(
    async ({ name, description }: NewWorkspace) => {
      const created = await createWorkspace(name, description);
      // A new folder also lands on a machine, so the computer rows move too.
      invalidateNewWorkspace(queryClient);
      return created;
    },
    [queryClient],
  );
}
