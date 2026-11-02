import type { Config } from 'tailwindcss';

// Tailwind 配置：扫描 app 与 components 目录下的组件类名
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Apple 风格的靛蓝主色（接近 iOS 系统蓝紫）
        brand: {
          50: '#f0f2ff',
          100: '#e3e7ff',
          200: '#c7cfff',
          300: '#a5b1ff',
          400: '#818cff',
          500: '#6366f1',
          600: '#5158e8',
          700: '#4348c9',
        },
        ink: {
          DEFAULT: 'var(--color-ink)',
          2: 'var(--color-ink-2)',
          muted: 'var(--color-ink-muted)',
          900: '#0b1220',
          700: '#334155',
          500: '#64748b',
          400: '#8a94a6',
        },
        canvas: '#f5f5f7',
        // Cobalt 材质色（变量定义在 globals.css :root）
        paper: {
          DEFAULT: 'var(--color-paper)',
          2: 'var(--color-paper-2)',
          3: 'var(--color-paper-3)',
        },
        rule: {
          DEFAULT: 'var(--color-rule)',
          2: 'var(--color-rule-2)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          2: 'var(--color-accent-2)',
          wash: 'var(--color-accent-wash)',
          deep: 'var(--color-accent-deep)',
        },
        graphite: {
          DEFAULT: 'var(--color-graphite)',
          2: 'var(--color-graphite-2)',
          ink: 'var(--color-graphite-ink)',
          muted: 'var(--color-graphite-muted)',
        },
      },
      fontFamily: {
        display: [
          '"Segoe UI Variable Display"',
          '"SF Pro Display"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      borderRadius: {
        '4xl': '28px',
        '5xl': '34px',
      },
      boxShadow: {
        glass: '0 10px 40px -12px rgba(15, 23, 42, 0.18)',
        lift: '0 18px 50px -20px rgba(15, 23, 42, 0.28)',
        bubble: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -16px rgba(15, 23, 42, 0.22)',
        glow: '0 0 46px -12px rgba(99, 102, 241, 0.55)',
        night: '0 30px 70px -30px rgba(11, 18, 32, 0.55)',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        floatSlow: {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '50%': { transform: 'translate3d(0,-18px,0) scale(1.04)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.45', transform: 'scale(1)' },
          '50%': { opacity: '0.85', transform: 'scale(1.07)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        'float-slow': 'floatSlow 18s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
        breathe: 'breathe 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
