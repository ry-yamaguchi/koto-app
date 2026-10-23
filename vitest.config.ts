import { defineConfig } from 'vitest/config'

// 単体テストは純粋ロジックのみを対象にする（electron・DOM 非依存のモジュール）。
// レンダラ/メインどちらのモジュールも Vitest の変換でそのまま import できる。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 既定の5秒だと、機械が忙しいとき（全体を並列に回している最中）に、src を全部読む検査（丸数字・用語・
    // 「定義するのは○○だけ」など）が中身の失敗でなく時間切れで落ちる（0.6.22 3B-5 の関所で実際に落ちた）。
    // 単独なら数十ミリ秒の検査なので、止まったテストを見つける役目は30秒でも変わらない。
    testTimeout: 30_000,
  },
})
