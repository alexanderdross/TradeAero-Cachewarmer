import axios from 'axios';
import { loadConfig } from './config';

/**
 * Dispatch the TradeAero-Indexing GitHub Actions workflow.
 * Called automatically after a warming job completes when
 * orchestration.triggerIndexingAfterWarming = true.
 */
export async function triggerIndexing(): Promise<void> {
  const { orchestration } = loadConfig();

  if (!orchestration.githubPat) {
    throw new Error('orchestration.githubPat is not configured');
  }
  if (!orchestration.githubOwner || !orchestration.githubRepo || !orchestration.githubWorkflow) {
    throw new Error('orchestration github owner/repo/workflow are not configured');
  }

  const url =
    `https://api.github.com/repos/${orchestration.githubOwner}` +
    `/${orchestration.githubRepo}/actions/workflows/${orchestration.githubWorkflow}/dispatches`;

  await axios.post(
    url,
    { ref: orchestration.githubRef || 'main' },
    {
      headers: {
        Authorization: `Bearer ${orchestration.githubPat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    }
  );
}
