import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_TEXT_WRAP } from '../src/renderer/textWrap'

// ── 許可の札（✋ 毎回確認）が見えること（0.6.32-rc.1 の実機で見つけた2つの直しの固定）────────────
// 1. 切れ目の無い長い文（ページの読み取りの URL・長いコマンド）が折り返さず、札が右へはみ出して
//    末尾が横スクロールしないと見えなかった（322 字の URL で、幅 363px の枠から 2,470px はみ出した）。
// 2. 札が出たとき、会話が末尾まで送られず、札の下側（URL の行と「許可する」「拒否」）が枠の外に残った。
//    末尾へ送る処理が messages と isLoading にだけ反応していて、札は「考えています…」の吹き出しと
//    入れ替わりで出るため。
//
// 見え方（はみ出し・送りの位置）は Vitest では測れないので、ここではソースの形を当てる。
// 当て先は札の行ごと一意に書き、直す前の形を禁じる（当て先がほかの行にも出ると、壊しても通る）。
// 実物の見え方は rc の実機で測る（札の右端が枠の中・ボタンが枠の中）。

const SRC = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'ChatPanel.tsx'), 'utf8')
const count = (needle: string) => SRC.split(needle).length - 1

// 折り返しの指定は textWrap.ts の CHAT_TEXT_WRAP の1つ（吹き出しの本文と同じ。付け忘れた場所だけが溢れるので、
// 札でもクラスを手で並べず、この定数を使う）。

describe('許可の札: 切れ目の無い長い文を折り返す', () => {
  it('折り返しの定数は、切れ目の無い文字列も折る指定を含む', () => {
    expect(CHAT_TEXT_WRAP).toContain('break-words')
    expect(CHAT_TEXT_WRAP).toContain('[overflow-wrap:anywhere]')
  })

  it('札の見出しの文は ChatPanel.tsx に1か所だけ（当て先が一意）', () => {
    expect(count('✋ AIが次の操作の許可を求めています')).toBe(1)
  })

  it('1行目（操作の名前・URL・コマンド）の p に折り返しの定数が付く', () => {
    const fixed =
      '<p className={`text-sm text-ink ${CHAT_TEXT_WRAP}`}>✋ AIが次の操作の許可を求めています: ' +
      '<span className="font-mono text-sakura">{first}</span></p>'
    expect(count(fixed)).toBe(1)
    // 直す前の形（折り返しの指定なし）
    expect(SRC).not.toContain('<p className="text-sm text-ink">✋ AIが次の操作の許可を求めています')
  })

  it('2行目から先（理由・注意）の p にも折り返しの定数が付く', () => {
    const fixed = "<p className={`text-sm text-ink-secondary mt-1 ${CHAT_TEXT_WRAP}`}>{rest.join('\\n')}</p>"
    expect(count(fixed)).toBe(1)
    // 直す前の形（改行は保つが、切れ目の無い文字列は折り返さない）
    expect(SRC).not.toContain("mt-1 whitespace-pre-wrap\">{rest.join('\\n')}</p>")
  })
})

describe('許可の札: 出たとき・消えたときに会話を末尾へ送る', () => {
  it('末尾へ送る処理が、札の id にも反応する', () => {
    const fixed =
      "    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' })\n" +
      '  }, [messages, isLoading, pendingApproval?.id])'
    // 依存を直す前の形（[messages, isLoading]）へ戻すと、この2行の並びが消えて落ちる。
    // ファイル全体に「古い依存の形が無いこと」は求めない（別の effect が同じ依存を持つと、関係の無い変更で落ちる）。
    expect(count(fixed)).toBe(1)
  })

  it('末尾へ送る処理は1か所だけ（別の所に古い形が残っていない）', () => {
    expect(count('sc.scrollTo({ top: sc.scrollHeight')).toBe(1)
  })
})
