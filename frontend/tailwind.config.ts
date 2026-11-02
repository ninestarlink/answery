import type { Config } from 'tailwindcss';

// 材质层：色值统一来自 app/globals.css 的 :root 变量（RGB 三元组）。
// 纸上档案馆是浅色材质：中性色板按正常明暗排列，纸面白、墨色深。
const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

// 唯一信号：朱砂
const vermilion = {
  50: token('--accent-50'),
  100: token('--accent-100'),
  200: token('--accent-200'),
  300: token('--accent-300'),
  400: token('--accent-400'),
  500: token('--accent-500'),
  600: token('--accent-600'),
  700: token('--accent-700'),
};

// 状态色：成功用橄榄绿（报纸副色调，避免荧光绿）
const green = {
  50: 'rgb(239 242 230 / <alpha-value>)',
  100: 'rgb(225 231 209 / <alpha-value>)',
  200: 'rgb(200 211 168 / <alpha-value>)',
  300: 'rgb(169 186 128 / <alpha-value>)',
  400: 'rgb(138 157 92 / <alpha-value>)',
  500: 'rgb(110 138 70 / <alpha-value>)',
  600: 'rgb(86 114 56 / <alpha-value>)',
  700: 'rgb(67 90 44 / <alpha-value>)',
  800: 'rgb(51 69 36 / <alpha-value>)',
  900: 'rgb(37 51 26 / <alpha-value>)',
};

const apricot = {
  50: 'rgb(250 243 230 / <alpha-value>)',
  100: 'rgb(246 232 206 / <alpha-value>)',
  200: 'rgb(238 214 172 / <alpha-value>)',
  300: 'rgb(226 187 128 / <alpha-value>)',
  400: 'rgb(208 154 74 / <alpha-value>)',
  500: token('--apricot'),
  600: token('--apricot'),
  700: token('--apricot-deep'),
  800: token('--apricot-deep'),
  900: token('--apricot-deep'),
};

const red = {
  50: token('--accent-50'),
  100: token('--accent-100'),
  200: token('--accent-200'),
  300: token('--accent-300'),
  400: token('--accent-400'),
  500: token('--accent-500'),
  600: token('--accent-600'),
  700: token('--accent-700'),
  800: token('--accent-deep'),
  900: token('--accent-deep'),
};

const slate = {
  50: 'rgb(250 246 238 / <alpha-value>)',
  100: 'rgb(244 238 227 / <alpha-value>)',
  200: 'rgb(233 224 210 / <alpha-value>)',
  300: 'rgb(216 205 190 / <alpha-value>)',
  400: 'rgb(173 161 145 / <alpha-value>)',
  500: 'rgb(110 101 90 / <alpha-value>)',
  600: 'rgb(84 77 68 / <alpha-value>)',
  700: 'rgb(58 53 46 / <alpha-value>)',
  800: 'rgb(38 34 29 / <alpha-value>)',
  900: token('--ink'),
};

// Tailwind 配置：扫描 app 与 components 目录下的组件类名
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: token('--paper'),
          2: token('--paper-2'),
          3: token('--paper-3'),
        },
        rule: {
          DEFAULT: token('--rule'),
          2: token('--rule-2'),
        },
        slate,
        // 旧的紫/粉渐变统一收进朱砂；状态色各自保留语义
        brand: vermilion,
        indigo: vermilion,
        violet: vermilion,
        fuchsia: vermilion,
        sky: vermilion,
        teal: green,
        cyan: green,
        emerald: green,
        amber: apricot,
        rose: red,
        red,
        accent: {
          DEFAULT: token('--accent'),
          ink: token('--accent-ink'),
          hi: token('--accent-hi'),
          deep: token('--accent-deep'),
          soft: token('--accent-soft'),
          50: token('--accent-50'),
          100: token('--accent-100'),
          200: token('--accent-200'),
          300: token('--accent-300'),
          400: token('--accent-400'),
          500: token('--accent-500'),
          600: token('--accent-600'),
          700: token('--accent-700'),
        },
        muted: token('--muted'),
        faint: token('--faint'),
        apricot: {
          DEFAULT: token('--apricot'),
          deep: token('--apricot-deep'),
        },
        well: {
          DEFAULT: token('--well'),
          2: token('--well-2'),
          ink: token('--well-ink'),
          muted: token('--well-muted'),
          rule: token('--well-rule'),
        },
        card: token('--card'),
        day: {
          ink: token('--day-ink'),
          muted: token('--day-muted'),
        },
        fog: token('--fog'),
        point: {
          lo: token('--point-lo'),
          mid: token('--point-mid'),
          hi: token('--point-hi'),
        },
        ink: {
          DEFAULT: token('--ink'),
          900: token('--ink'),
          700: token('--ink-2'),
          500: token('--muted'),
          400: token('--faint'),
        },
        canvas: token('--paper'),
      },
      fontFamily: {
        sans: [
          '"Segoe UI"',
          '"Helvetica Neue"',
          'Helvetica',
          'Arial',
          '"Microsoft YaHei UI"',
          '"PingFang SC"',
          'sans-serif',
        ],
        display: [
          '"Iowan Old Style"',
          '"Palatino Linotype"',
          'Palatino',
          'Georgia',
          '"Songti SC"',
          '"Noto Serif SC"',
          '"Source Han Serif SC"',
          'serif',
        ],
        mono: [
          '"Cascadia Mono"',
          '"JetBrains Mono"',
          'Consolas',
          '"Microsoft YaHei UI"',
          '"PingFang SC"',
          'ui-monospace',
          'monospace',
        ],
        serif: [
          '"Iowan Old Style"',
          '"Palatino Linotype"',
          'Palatino',
          'Georgia',
          '"Songti SC"',
          '"Noto Serif SC"',
          '"Source Han Serif SC"',
          'serif',
        ],
      },
      fontWeight: {
        thin: '300',
      },
      // 磁带/档案：2px 方角，控件也保持硬边
      borderRadius: {
        sm: '1px',
        DEFAULT: '2px',
        md: '2px',
        lg: '2px',
        xl: '2px',
        '2xl': '2px',
        '3xl': '2px',
        '4xl': '4px',
        '5xl': '4px',
      },
      // 工业海报：细线 + 硬投影（不做柔和大阴影）
      boxShadow: {
        glass: 'inset 0 0 0 1px rgb(204 192 175), 5px 5px 0 rgb(23 21 18 / 0.05)',
        lift: 'inset 0 0 0 1px rgb(204 192 175), 7px 7px 0 rgb(23 21 18 / 0.055)',
        bubble: 'inset 0 0 0 1px rgb(204 192 175), 3px 3px 0 rgb(23 21 18 / 0.04)',
        glow: 'none',
        night: 'inset 0 0 0 1px rgb(204 192 175), 10px 10px 0 rgb(23 21 18 / 0.08)',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        floatSlow: {
          '0%, 100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(0,-8px,0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.45' },
          '50%': { opacity: '0.85' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        'float-slow': 'floatSlow 18s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
        breathe: 'breathe 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
