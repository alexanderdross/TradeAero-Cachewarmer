import axios from 'axios';

/**
 * Trigger the TradeAero-Indexing workflow via GitHub Actions API.
 * All config is read from environment variables set in the Vercel project:
 *   GITHUB_PAT      — Personal Access Token with `workflow` scope
 *   GITHUB_OWNER    — Repository owner (default: alexanderdross)
 *   GITHUB_REPO     — Repository name  (default: TradeAero-Indexing)
 *   GITHUB_WORKFLOW — Workflow file    (default: index-listings.yml)
 *   GITHUB_REF      — Branch/ref      (default: main)
 */
export async function triggerIndexing(): Promise<void> {
  const pat = process.env.GITHUB_PAT;
  const owner = process.env.GITHUB_OWNER ?? 'alexanderdross';
  const repo = process.env.GITHUB_REPO ?? 'TradeAero-Indexing';
  const workflow = process.env.GITHUB_WORKFLOW ?? 'index-listings.yml';
  const ref = process.env.GITHUB_REF ?? 'main';

  if (!pat) throw new Error('GITHUB_PAT environment variable is not set');

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  await axios.post(
    url,
    { ref },
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    }
  );
}
