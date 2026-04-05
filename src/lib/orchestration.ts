import axios from 'axios';

interface OrchestrationConfig {
  githubPat?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubWorkflow?: string;
  githubRef?: string;
}

export async function triggerIndexing(config: OrchestrationConfig): Promise<void> {
  const { githubPat, githubOwner, githubRepo, githubWorkflow, githubRef } = config;
  if (!githubPat || !githubOwner || !githubRepo || !githubWorkflow) {
    throw new Error('orchestration: githubPat, owner, repo, and workflow are required');
  }
  const url = `https://api.github.com/repos/${githubOwner}/${githubRepo}/actions/workflows/${githubWorkflow}/dispatches`;
  await axios.post(
    url,
    { ref: githubRef || 'main' },
    {
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    }
  );
}
