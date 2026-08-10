import { defineConfig } from 'vitest/config'

// 単体テストは純粋ロジックのみを対象にする（electron・DOM 非依存のモジュール）。
// レンダラ/メインどちらのモジュールも Vitest の変換でそのまま import できる。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
