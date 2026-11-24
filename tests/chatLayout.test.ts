import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { CHAT_NOTICE_CLASS, CHAT_LIST_MIN_CLASS } from '../src/renderer/chatLayout'

// P-141: 入力欄の上の案内が高さの上限なしだと、低い窓で会話の枠を押しつぶし、札のボタンが隠れた。
// 描画の環境が無いので、寸法のクラスが定数にあり、ChatPanel がその定数を使っていることを固定する。
const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')

describe('チャット欄の縦の寸法（P-141）', () => {
  it('案内には高さの上限と、超えたときの縦スクロールが付く', () => {
    expect(CHAT_NOTICE_CLASS).toMatch(/\bmax-h-\[\d+vh\]/)
    expect(CHAT_NOTICE_CLASS).toContain('overflow-y-auto')
  })
  it('会話の枠には最小の高さが付く', () => {
    expect(CHAT_LIST_MIN_CLASS).toMatch(/\bmin-h-\[\d+px\]/)
  })
  it('ChatPanel は案内の枠と会話の枠にその定数を付けている', () => {
    expect(panel).toMatch(/\$\{CHAT_NOTICE_CLASS\}[^]{0,80}<MigrateNotice/)
    expect(panel).toMatch(/relative \$\{CHAT_LIST_MIN_CLASS\}/)
  })
  it('札が出たら末尾へ送る作り（0.6.32）が残っている', () => {
    expect(panel).toContain('sc.scrollTo({ top: sc.scrollHeight')
    expect(panel).toContain('pendingApproval?.id')
  })

  // rc39-D1（ソースの形の固定）: 実寸の確かめは実機。ここでは「縮めない枠に戻していない」ことだけを固定する。
  it('★ 案内の枠は縮めてよい形（shrink と min-h-0 があり、flex-none が無い）— ソースの形の固定', () => {
    expect(CHAT_NOTICE_CLASS).toMatch(/(^|\s)shrink(\s|$)/)
    expect(CHAT_NOTICE_CLASS).toMatch(/(^|\s)min-h-0(\s|$)/)
    expect(CHAT_NOTICE_CLASS).not.toContain('flex-none')
    const start = panel.indexOf('${CHAT_NOTICE_CLASS}')
    expect(start).toBeGreaterThan(-1)
    const cls = panel.slice(panel.lastIndexOf('className=', start), panel.indexOf('>', start))
    expect(cls).not.toContain('flex-none')
  })
})
