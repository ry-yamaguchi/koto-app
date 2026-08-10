/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // NOTE: `rgb(var(--x-rgb) / <alpha-value>)` 形式で定義する（`var(--x)` 直参照ではない）。
        // 理由: 色の実体が hex の CSS変数だと、Tailwind の不透明度修飾（例: bg-ink/80）が
        // ビルド時に色を解析できず、クラスごと生成されない（黙って無効になる）バグがあったため。
        // <alpha-value> プレースホルダ経由にすることで bg-ink/80 等が正しく機能する。
        // 変数の実体（-rgb 版）は index.css の :root / .theme-light 側で定義。
        base: 'rgb(var(--bg-base-rgb) / <alpha-value>)',
        surface: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated-rgb) / <alpha-value>)',
        overlay: 'rgb(var(--bg-overlay-rgb) / <alpha-value>)',
        line: 'rgb(var(--border-rgb) / <alpha-value>)',
        'line-soft': 'rgb(var(--border-soft-rgb) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--text-muted-rgb) / <alpha-value>)',
        },
        sakura: {
          DEFAULT: 'rgb(var(--sakura-rgb) / <alpha-value>)',
          hover: 'rgb(var(--sakura-hover-rgb) / <alpha-value>)',
          soft: 'rgb(var(--sakura-soft-rgb) / <alpha-value>)',
        },
        brand: {
          green: 'rgb(var(--green-rgb) / <alpha-value>)',
          blue: 'rgb(var(--blue-rgb) / <alpha-value>)',
          yellow: 'rgb(var(--yellow-rgb) / <alpha-value>)',
          orange: 'rgb(var(--orange-rgb) / <alpha-value>)',
          cyan: 'rgb(var(--cyan-rgb) / <alpha-value>)',
          red: 'rgb(var(--red-rgb) / <alpha-value>)',
        },
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
      },
    },
  },
  plugins: [],
}
