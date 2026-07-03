/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // No rewrites needed — nginx routes /api/* directly to the api container
  // and /socket.io/ to the api container for WebSockets
}

module.exports = nextConfig
