import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // p-limit v5 and google-auth-library use Node.js-specific imports (#async_hooks,
  // node: protocol) that webpack cannot bundle. Mark them as external so Next.js
  // lets Node.js resolve them natively at runtime.
  serverExternalPackages: ['p-limit', 'google-auth-library'],
};

export default nextConfig;
