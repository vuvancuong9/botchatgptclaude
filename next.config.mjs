/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    // node:sqlite is a Node built-in; keep it external to the bundle.
  },
};

export default nextConfig;
