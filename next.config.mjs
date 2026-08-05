/** @type {import('next').NextConfig} */
const nextConfig = {
  // @resvg/resvg-js ships a native .node binary — webpack can't bundle
  // that, so it has to be loaded via plain require() at runtime instead.
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default nextConfig;
