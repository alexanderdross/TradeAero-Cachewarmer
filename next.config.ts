import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle under .next/standalone so the Docker
  // runtime image only needs the traced node_modules subset. Skipped on
  // Vercel: its build wrapper manages output itself, and 'standalone' trips
  // Vercel's modifyConfig step (ERR_INVALID_ARG_TYPE — path is undefined).
  output: process.env.VERCEL ? undefined : 'standalone',
  // p-limit v5 and google-auth-library use Node.js-specific imports (#async_hooks,
  // node: protocol) that webpack cannot bundle. Mark them as external so Next.js
  // lets Node.js resolve them natively at runtime.
  serverExternalPackages: ['p-limit', 'google-auth-library'],
};

export default nextConfig;
