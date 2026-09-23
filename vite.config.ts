import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    rollupOptions: {
      external: ['electron']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer')
    }
  },
  server: {
    port: 5173,
    // 開発用サーバーの見張り範囲（2026-09-16・D-16 C）。
    // なぜ: 文書を1文直すたびに画面が丸ごと読み込み直され、**操作の途中の状態が消えていた**
    // （書きかけの入力・開いていたパネル・スクロール位置）。docs/ や CHANGELOG は画面の
    // 中身に一切関係しないので、見張りから外す。
    // **配布版には影響しない**（`vite build` は server の設定を読まない＝開発用サーバーだけの話）。
    // 外さないもの: src/**・index.html・vite.config.ts 自身・package.json
    // （これらは画面に関係する＝直したら読み込み直してほしい）。
    watch: {
      ignored: [
        '**/docs/**',
        '**/README.md',
        '**/CHANGELOG.md',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/scripts/**',
        '**/tests/**',
        '**/*.md',
      ]
    }
  }
})
