/**
 * 聊天 SSE 直通代理。
 *
 * 为什么需要这个文件：
 * next.config.mjs 的 rewrites 会把 /api/* 转发给 FastAPI，但 Next 的 rewrite
 * 代理会先把上游响应整体读完再回吐，SSE 逐帧流式被压成「最后一次性到达」，
 * 表现为前端首字很慢、回答结束更慢。这里改用 Route Handler 原样透传
 * ReadableStream，保持流式；其它 /api/* 仍走 rewrites。
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 与 next.config.mjs 保持一致的转发目标 */
const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';

export async function POST(req: Request) {
  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/chat/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body,
      cache: 'no-store',
      signal: req.signal,
    });
  } catch {
    return new Response(
      'data: {"event":"error","message":"无法连接 AI 服务，请稍后重试。"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform：禁止中间层压缩缓冲，保证每帧立即下发
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
