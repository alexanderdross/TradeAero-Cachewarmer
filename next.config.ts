import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // p-limit v5 and google-auth-library use Node.js-specific imports (#async_hooks,
  // node: protocol) that webpack cannot bundle. Mark them as external so Next.js
  // lets Node.js resolve them natively at runtime.
  serverExternalPackages: ['p-limit', 'google-auth-library'],

  // Skip Next.js's bundled ESLint pass during `next build` (Vercel deploys).
  // The GitHub Actions `CI / Lint (ESLint)` job is already the required pre-
  // merge gate and uses our flat config; running Next's ESLint again at build
  // time is pure duplication — and worse, it runs eslint-config-next even
  // though this service has no UI, so the Next plugin's rules (no-img-element,
  // no-html-link-for-pages, google-font-display, …) produce nothing useful.
  // Revisit if a UI is ever added: adopt eslint-config-next in the flat
  // config and drop this flag so the Next rules run in CI alongside ours.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
