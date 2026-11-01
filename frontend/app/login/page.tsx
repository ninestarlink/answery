'use client';

import { useState } from 'react';
import { clearSession, login } from '@/lib/auth';

export default function LoginPage() {
  const [username, setUsername] = useState('13800001234');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      // 控制台只对管理员开放；普通客户登录直接提示，避免进去处处 403
      if (user.role !== 'admin') {
        clearSession();
        setError('该账号没有控制台权限，请使用管理员账号');
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next') ?? '/';
      window.location.href = next.startsWith('/') ? next : '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f6fb] px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="hero-night relative overflow-hidden rounded-[28px] px-6 pb-7 pt-7 text-white shadow-night">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="dot-grid-dark absolute inset-0 opacity-60" />
            <div className="aurora-blob aura-indigo -left-24 -top-32 h-[320px] w-[320px]" />
            <div className="aurora-blob aura-pink -right-20 top-8 h-[260px] w-[260px]" />
          </div>

          <div className="relative">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
              管理控制台
            </span>
            <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-tight">
              登录 AnswerY智能客服中台
            </h1>
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/55">
              控制台接口已启用 JWT + 角色鉴权，仅管理员可访问监控、数据库与索引重建。
            </p>

            <form onSubmit={submit} className="mt-6 space-y-3">
              <label className="block">
                <span className="text-[11.5px] font-medium text-white/70">手机号 / 客户编号</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="mt-1.5 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-[13.5px] text-white placeholder:text-white/35 outline-none transition focus:border-white/35 focus:bg-white/15"
                  placeholder="13800001234"
                />
              </label>

              <label className="block">
                <span className="text-[11.5px] font-medium text-white/70">密码</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="mt-1.5 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-[13.5px] text-white placeholder:text-white/35 outline-none transition focus:border-white/35 focus:bg-white/15"
                  placeholder="demo1234"
                />
              </label>

              {error && (
                <div className="rounded-xl border border-rose-300/30 bg-rose-500/15 px-3 py-2 text-[12px] text-rose-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="press mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-[13.5px] font-semibold text-slate-900 transition hover:bg-slate-100 disabled:opacity-60"
              >
                {loading ? '登录中…' : '登录'}
              </button>
            </form>

            <div className="mt-4 flex items-center justify-between text-[11px] text-white/45">
              <span>演示管理员：13800001234 / demo1234</span>
              <a href="/" className="transition hover:text-white">
                返回首页 →
              </a>
            </div>
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          普通客户账号 13900002345 可登录，但无权进入控制台
        </p>
      </div>
    </div>
  );
}
