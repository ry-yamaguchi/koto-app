import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { OSV_SEND_NOTE } from '../src/shared/dataDestinationNotes'
import {
  OSV_BUTTON_LABEL, OSV_CONFIRM_OK, OSV_CONFIRM_CANCEL, OSV_SETTINGS_TITLE, OSV_SETTINGS_REVOKE,
} from '../src/renderer/osvCheckWords'

// 公開される文書だけを読む（README.md・使い方ガイド・SECURITY.md）。
const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const README = read('README.md')
const GUIDE = read('docs/usage-guide.html')
const SECURITY = read('SECURITY.md')
const DOCS: Array<[string, string]> = [['README.md', README], ['usage-guide.html', GUIDE], ['SECURITY.md', SECURITY]]

describe('OSV の文書', () => {
  it('README と使い方ガイドは、画面と同じ送る先の一文を含む', () => {
    const sentence = OSV_SEND_NOTE.replace(/。$/, '')
    expect(README).toContain(sentence)
    expect(GUIDE).toContain(sentence)
  })

  it('古い文が残っていない', () => {
    expect(README).not.toContain('既知の脆弱性データベースとの照合／依存ライブラリの脆弱性検査')
    expect(GUIDE).not.toContain('既知の脆弱性データベースとの照合、使っているライブラリの脆弱性の点検')
    expect(SECURITY).not.toContain('既知の脆弱性データベースとの照合・依存ライブラリの検査・動的な攻撃の試行は行いません')
  })

  it('ボタンと設定の名前が画面と合っている', () => {
    for (const [, src] of DOCS) expect(src).toContain(OSV_BUTTON_LABEL)
    for (const w of [OSV_CONFIRM_OK, OSV_CONFIRM_CANCEL]) expect(GUIDE).toContain(w)
    expect(GUIDE).toContain(`「${OSV_SETTINGS_TITLE}」</b> の <b>【${OSV_SETTINGS_REVOKE}】`)
  })

  it('IP アドレスが相手に伝わること・相手側の扱いが見つかっていないことを書く', () => {
    expect(README).toContain('送信元の IP アドレスは OSV.dev に伝わります')
    expect(GUIDE).toContain('送信元の IP アドレスは OSV.dev に伝わります')
    expect(SECURITY).toContain('送信元の IP アドレスは相手に伝わります')
    expect(GUIDE).toContain('公開の文書に記述が見つかっていません')
  })

  it('同意の前に起きることを言い切りすぎない（下調べはファイルを読む・送るものを「だけ」と言わない）', () => {
    expect(README).toContain('初回の確認に同意していなければ、OSV.dev へは通信しません')
    expect(README).toContain('下調べは、`package.json` と `package-lock.json` を読むだけで、通信しません')
    expect(README).not.toContain('ファイルも読まず通信もしません')
    expect(SECURITY).not.toContain('見つかった弱点の ID だけです')
  })

  it('見分けられないもの（npmjs.org に置いた非公開のライブラリは送られる）を、3つとも書く', () => {
    for (const [name, src] of DOCS) {
      expect(src, name).toContain('非公開のライブラリは、公開のものと見分けられないため、名前とバージョンが送られます')
    }
  })

  it('見つからないことは安全の保証ではない、と3つとも書く', () => {
    for (const [, src] of DOCS) expect(src).toContain('見つからないことは、安全の保証ではありません')
  })

  it('SECURITY.md は宛先と、相手側の扱いが見つかっていないことを書く', () => {
    expect(SECURITY).toContain('api.osv.dev')
    expect(SECURITY).toContain('公開の文書に記述が見つかっていません')
  })

  it('足した段落に、禁じる語が無い', () => {
    const banned = ['無償', '無料', 'Claude Code', 'OWASP', '準拠', '対策済み', '部品', '道具', /[①-⑳]/]
    for (const [name, src] of DOCS) {
      const lines = src.split('\n').filter(l => l.includes('ライブラリの脆弱性') || l.includes('OSV'))
      expect(lines.length, name).toBeGreaterThan(0)
      for (const l of lines) {
        for (const b of banned) {
          const hit = typeof b === 'string' ? l.includes(b) : b.test(l)
          expect(hit, `${name}: ${String(b)}`).toBe(false)
        }
      }
    }
  })

  it('AI の利用量の一覧には入れない・節の見出しはそのまま', () => {
    const at = GUIDE.indexOf('<h2>AIの利用量がかかる場面')
    expect(at).toBeGreaterThan(-1)
    const rest = GUIDE.slice(at + 4)
    const end = rest.search(/<h2[ >]/)
    const section = end >= 0 ? rest.slice(0, end) : rest
    expect(section).not.toContain('ライブラリの脆弱性')
    expect(GUIDE).toContain('<h2>簡易セキュリティチェック（🛡）</h2>')
  })
})
