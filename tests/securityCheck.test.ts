import { describe, it, expect } from 'vitest'
import { pickCheckTargets, judgeVerdict } from '../src/renderer/securityCheck'

// 2026-08-09 の総点検で見つかった2件の回帰テスト。
// 公開前セキュリティチェックは「守り」のコードなのに、テストが1件も無かった（掟10）。

// ── 秘密ファイルの中身をAIへ送らない ────────────────────────────────────
// 以前は対象の正規表現が `.env` にマッチしており、**中身（APIキーやDBパスワード）が
// さくらのAI Engine へ送信されていた**。名前だけで公開NGと判定できるので、送る必要はない。
describe('チェックにかけるファイルの選び方', () => {
  it('秘密ファイルは中身を送らず、名前だけを指摘に回す', () => {
    const { targets, secretFiles } = pickCheckTargets(['index.html', '.env', '.env.production'])
    expect(targets).toEqual(['index.html'])
    expect(secretFiles).toContain('.env')
    expect(secretFiles).toContain('.env.production')
  })

  it('秘密鍵や証明書も中身を送らない', () => {
    const { targets, secretFiles } = pickCheckTargets(['app.js', 'id_rsa', 'server.pem'])
    expect(targets).toEqual(['app.js'])
    expect(secretFiles).toEqual(['id_rsa', 'server.pem'])
  })

  it('名前に credentials / secret を含むものも指摘する', () => {
    const { secretFiles } = pickCheckTargets(['credentials.json', 'my-secret.txt', 'index.html'])
    expect(secretFiles).toContain('credentials.json')
    expect(secretFiles).toContain('my-secret.txt')
  })

  it('Koto 自身のメタ情報は指摘しない（利用者の秘密ではない）', () => {
    const { secretFiles } = pickCheckTargets(['.sakuraide.json'])
    expect(secretFiles).toEqual([])
  })

  it('普通のコード・設定ファイルは中身を見る', () => {
    const { targets } = pickCheckTargets(['index.html', 'style.css', 'script.js', 'Dockerfile', '.htaccess', 'config.yaml'])
    expect(targets).toContain('index.html')
    expect(targets).toContain('Dockerfile')
    expect(targets).toContain('.htaccess')
    expect(targets).toContain('config.yaml')
  })

  it('対象は8件までに絞る（送りすぎない）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `page${i}.html`)
    expect(pickCheckTargets(many).targets).toHaveLength(8)
  })

  it('画像やフォントは対象外', () => {
    const { targets } = pickCheckTargets(['logo.png', 'font.woff2', 'index.html'])
    expect(targets).toEqual(['index.html'])
  })
})

// ── 判定は「要確認」を優先する ──────────────────────────────────────────
// 以前は1行目に「問題なし」が含まれるかだけを見ていたため、
// 「判定: 要確認（一部は問題なし）」のような書き方をされると ok になっていた。
describe('AIの回答から判定を決める', () => {
  it('問題なしなら ok', () => {
    expect(judgeVerdict('判定: 問題なし\n確認した観点: 秘密情報の直書き、XSS')).toBe('ok')
  })

  it('要確認なら warn', () => {
    expect(judgeVerdict('判定: 要確認\nindex.html: APIキーが直書きされています')).toBe('warn')
  })

  // ここが実害。両方の語が入っていたら警告側に倒す
  it('両方の語が入っていたら warn（安全側に倒す）', () => {
    expect(judgeVerdict('判定: 要確認（一部は問題なし）\n…')).toBe('warn')
    expect(judgeVerdict('判定: 問題なし。ただし要確認の点あり\n…')).toBe('warn')
  })

  it('形式に従わない回答は warn（判定できないものを ok にしない）', () => {
    expect(judgeVerdict('こんにちは')).toBe('warn')
    expect(judgeVerdict('')).toBe('warn')
  })

  it('2行目以降に問題なしと書かれていても、1行目で判断する', () => {
    expect(judgeVerdict('判定: 要確認\nstyle.css: 問題なし')).toBe('warn')
  })
})
