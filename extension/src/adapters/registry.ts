/**
 * Adapter registry.
 *
 * Adding a job board is: write the adapter, import it here, add it to the array,
 * and add its paths to the manifest's `content_scripts.matches`. Nothing else in
 * the codebase changes. See docs/adding-a-job-board.md.
 */
import { linkedInAdapter } from './linkedin';
import type { JobBoardAdapter } from './types';

export const ADAPTERS: JobBoardAdapter[] = [linkedInAdapter];

export function adapterFor(url: URL): JobBoardAdapter | null {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matches(url)) return adapter;
    } catch (err) {
      console.debug('[SponsorScope] adapter.matches threw', adapter.id, err);
    }
  }
  return null;
}
