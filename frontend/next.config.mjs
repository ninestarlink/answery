/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 同源代理：浏览器只访问前端域名，/api 与 /health 由 Next 转发给本机 FastAPI。
  // 这样外网访问时不会请求访问者自己的 localhost:8000，也省掉跨域配置。
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';
    return [
      { source: '/health', destination: `${backend}/health` },
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
    ];
  },
};

export default nextConfig;
