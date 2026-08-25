import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { isComposing, isSubmitEnter } from '../src/renderer/keyInput'

// ── 日本語入力（IME）の Enter（2026-08-24 Ryosuke 報告）─────────────────
// 「何か書いた途端に回答の生成が始まる」の原因。漢字に変換して確定するときにも
// Enter を押すので、`e.key === 'Enter'` だけを見ていると変換の確定で実行してしまう。

describe('変換の途中かを見分ける', () => {
  it('isComposing が立っていれば変換中', () => {
    expect(isComposing({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true)
  })

  // 取れない環境向けの控え。229 は IME 処理中を表す昔からの目印。
  it('keyCode 229 でも変換中とみなす（生のイベント・React 側のどちらでも）', () => {
    expect(isComposing({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(true)
    expect(isComposing({ key: 'Enter', keyCode: 229 })).toBe(true)
  })

  it('変換していなければ false', () => {
    expect(isComposing({ key: 'Enter', nativeEvent: { isComposing: false } })).toBe(false)
    expect(isComposing({ key: 'Enter' })).toBe(false)
  })
})

describe('実行してよい Enter か', () => {
  it('ふつうの Enter は実行してよい', () => {
    expect(isSubmitEnter({ key: 'Enter' })).toBe(true)
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: { isComposing: false } })).toBe(true)
  })

  // ⚠️ ここが実害だった。変換の確定で検索・保存・改名が走っていた。
  it('変換の確定では実行しない', () => {
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', keyCode: 229 })).toBe(false)
  })

  it('Enter 以外は実行しない', () => {
    expect(isSubmitEnter({ key: 'Escape' })).toBe(false)
    expect(isSubmitEnter({ key: 'a' })).toBe(false)
  })

  it('こわれた値でも落ちない', () => {
    expect(isSubmitEnter({ key: 'Enter', nativeEvent: null })).toBe(true)
    expect(isSubmitEnter({} as any)).toBe(false)
  })
})

// ── 配線（画面は import できないのでソースを読んで固定。掟10）──────────────
describe('Enter を見ている場所は、すべて一元化した判定を通す', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  /**
   * 修飾キーなしの Enter を実行の合図にしている場所（**書き下す**。
   * 一覧を回すだけだと、中身が減っても気づけない・掟10 の戒め）。
   */
  const PLAIN_ENTER_FILES = [
    'src/renderer/components/KnowledgeModal.tsx',        // 資料への質問（報告された症状）
    'src/renderer/components/KnowledgeCollectorTab.tsx', // Webから資料を作る（検索）
    'src/renderer/components/AppRunPanel.tsx',           // 名前・IPの入力
    'src/renderer/components/Sidebar.tsx',               // 名前ダイアログ（実害あり）
    'src/renderer/components/CredentialsModal.tsx',      // 入力を確定して blur
  ]

  it('直す前の形（生の Enter 判定）が1つも残っていない', () => {
    for (const f of PLAIN_ENTER_FILES) {
      const s = read(f)
      expect(s, f).toContain("from '../keyInput'")
      // `e.key === 'Enter'` の生判定は、Escape 等を除いて残っていないこと
      const bare = s.split("e.key === 'Enter'").length - 1
      expect(bare, `${f} に生の Enter 判定が残っている`).toBe(0)
    }
  })

  it('AppRun は2箇所とも通している（片方だけ直さない）', () => {
    const s = read('src/renderer/components/AppRunPanel.tsx')
    expect(s.split('isSubmitEnter(e)').length - 1).toBe(2)
  })

  // ⌘+Enter の場所は、修飾キーが要るので変換の確定と重ならない。動いているものを触らない。
  it('チャットの送信（⌘+Enter）は、これまでどおりにしてある', () => {
    for (const f of ['src/renderer/components/ChatPanel.tsx', 'src/renderer/components/ChatApp.tsx']) {
      expect(read(f), f).toContain("e.key === 'Enter' && (e.metaKey || e.ctrlKey)")
    }
  })
})

// ── 📚 資料の画面（2026-08-25 Ryosuke と設計）─────────────────────────────
// 「使う／使わない」はプロジェクトごとの設定なのに、編集できるのは
// **アプリ全体の資料ダイアログの中**だけで、**使う場所には一度も出ていなかった**。
describe('📚 資料の置き場所と文言', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('「このプロジェクトで使う」は資料ダイアログから外し、行き先を案内する', () => {
    const s = read('src/renderer/components/KnowledgeModal.tsx')
    expect(s).not.toContain('④ このプロジェクトで使う')
    expect(s).not.toContain('このプロジェクトのチャットで資料を使う\n')
    // **機能が消えたと思わせない**
    expect(s).toContain('チャット上部の「📚」')
  })

  it('切替はチャットに置き、資料が無ければ押しても黙らない', () => {
    const s = read('src/renderer/components/ChatPanel.tsx')
    expect(s).toContain("{ragEnabled ? '📚 資料を使う' : '📚 資料を使わない'}")
    // 0件のときは切り替えずに知らせる（押しても何も起きないボタンにしない）
    expect(s).toContain('まだ資料が登録されていません')
    expect(s).toContain("window.electronAPI.rag.list(apiKey, { pageSize: 1 })")
    // 書き込み口は共通（掟10）
    expect(s).toContain("import { saveRagSettings } from '../ragContext'")
  })

  // ⚠️ ヘッダーに並べたら**横に長くなりすぎて、窓を狭めると隠れた**（2026-08-25 Ryosuke 報告）。
  // この2つは「誰が答えるか」ではなく「送るとどう扱われるか」なので、送る場所の隣へ。
  it('切替は入力欄の直上に置く（ヘッダーにも会話の中にも置かない）', () => {
    const s = read('src/renderer/components/ChatPanel.tsx')
    const rowAt = s.indexOf('送るときの扱い（2026-08-25 Ryosuke 提案）')
    const inputAt = s.indexOf('placeholder="メッセージを入力…"')
    const messagesAt = s.indexOf('{/* Messages */}')
    expect(rowAt).toBeGreaterThan(0)
    // 会話より後ろ＝会話に流されない、かつ入力欄より前＝送る場所の隣
    expect(rowAt).toBeGreaterThan(messagesAt)
    expect(rowAt).toBeLessThan(inputAt)
    expect(s.indexOf('onClick={toggleWriteMode}')).toBeGreaterThan(rowAt)
    expect(s.indexOf('onClick={toggleRag}')).toBeGreaterThan(rowAt)
    expect(s.indexOf('onClick={toggleWriteMode}')).toBeLessThan(inputAt)
  })

  // ⚠️ 2026-08-25 Ryosuke 指摘。「何が AI に送られているか」の表示のつもりだったが
  // 成り立たない。AI は read_file でどのファイルでも読めるので**境界を表していない**し、
  // 見ても止められないし、会話には実際に読んだファイルが出ている。
  it('開いているファイル名のチップは出さない', () => {
    const s = read('src/renderer/components/ChatPanel.tsx')
    expect(s).not.toContain('📄 {activeFile.name}')
  })

  // 初めて開くと一覧は空。追加を先に置く。
  it('資料の画面は「追加 → 一覧 → 検索」の順で番号が振ってある', () => {
    const s = read('src/renderer/components/KnowledgeModal.tsx')
    const at = (needle: string) => s.indexOf(needle)
    expect(at('① 資料を追加')).toBeGreaterThan(0)
    expect(at('② 登録済みの資料')).toBeGreaterThan(at('① 資料を追加'))
    expect(at('③ 資料を検索')).toBeGreaterThan(at('② 登録済みの資料'))
  })

  // 目的は「登録した資料がちゃんと引けるか」の確認。回答だけでは分からない。
  it('検索の結果は、当たった資料の名前・場所・本文まで見せる', () => {
    const s = read('src/renderer/components/KnowledgeModal.tsx')
    expect(s).toContain('見つかったところ')
    expect(s).toContain('番目の区切り')
    expect(s).toContain('h.excerpt')
    // 見つからなかったことも、はっきり言う（回答だけ出すと効いたように見える）
    expect(s).toContain('当てはまる資料は見つかりませんでした')
    // 応答は前からこれを返していた。追加の呼び出しは増やさない
    expect(s.split('window.electronAPI.rag.chat(').length - 1).toBe(1)
    expect(s).not.toContain('window.electronAPI.rag.query(')
  })
})
