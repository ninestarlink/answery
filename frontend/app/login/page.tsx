﻿'use client';

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
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="masthead mb-3 flex items-end justify-between pb-2 pt-2">
          <span className="mono-label text-ink">Access Control / 访问许可</span>
          <span className="mono-label text-accent">C—00</span>
        </div>
        <div className="well ticks relative overflow-hidden px-6 pb-7 pt-7">
          <div className="relative">
            <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-well-rule bg-well-2 px-2 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-deep" />
              <span className="mono-label text-[9px] text-well-muted">管理控制台</span>
            </span>
            <h1 className="mt-4 text-[23px] leading-tight text-well-ink">
              登录 AnswerY智能客服中台
            </h1>
            <p className="mt-2 text-[12.5px] leading-relaxed text-well-muted">
              控制台接口已启用 JWT + 角色鉴权，仅管理员可访问监控、数据库与索引重建。
            </p>

            <form onSubmit={submit} className="mt-6 space-y-3">
              <label className="block">
                <span className="mono-label text-[9px] text-well-muted">手机号 / 客户编号</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="mt-1.5 w-full rounded-[2px] border border-well-rule bg-well-2 px-3 py-2.5 font-mono text-[13px] text-well-ink placeholder:text-well-muted/70 outline-none transition focus:border-accent/60 focus:ring-1 focus:ring-accent/25"
                  placeholder="13800001234"
                />
              </label>

              <label className="block">
                <span className="mono-label text-[9px] text-well-muted">密码</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="mt-1.5 w-full rounded-[2px] border border-well-rule bg-well-2 px-3 py-2.5 font-mono text-[13px] text-well-ink placeholder:text-well-muted/70 outline-none transition focus:border-accent/60 focus:ring-1 focus:ring-accent/25"
                  placeholder="demo1234"
                />
              </label>

              {error && (
                <div className="rounded-[2px] bg-apricot/15 px-3 py-2 text-[12px] text-apricot-deep">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="press mt-1 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[2px] bg-accent text-[14px] font-semibold text-accent-ink shadow-[4px_4px_0_rgba(23,21,18,0.18)] transition hover:bg-accent-hi disabled:opacity-60"
              >
                {loading ? '登录中…' : '登录'}
              </button>
            </form>

            <div className="mt-4 flex items-center justify-between text-[11px] text-well-muted">
              <span>演示管理员：13800001234 / demo1234</span>
              <a href="/" className="transition hover:text-accent-deep">
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
