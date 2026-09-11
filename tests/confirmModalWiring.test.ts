import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 判断9（2026-09-11）: 確認ダイアログを Koto 様式（ConfirmModal）に統一する。
// window.confirm を使っていた3箇所（RollbackSection・Sidebar のファイル移動・
// AppRunDedicatedPanel ⑤⑥）が、実際に ConfirmModal（useConfirm 経由）へ置き換わっている
// ことを、ソースを読んで固定する（掟10: 「一元化した」と「全経路が実際に通っている」は別）。
//
// 判断ロジック（confirm が false を返せば実行しない）そのものは:
//   - RollbackSection → tests/rollbackSectionDeps.test.ts・tests/apprunTraffic.test.ts
//   - AppRunDedicatedPanel ⑤⑥ → tests/apprunDedicatedActions.test.ts・tests/apprunDedicatedWiring.test.ts
//   - useConfirm 自体の選択判断（resolveConfirm） → tests/useConfirm.test.ts（完了条件の変異試験(c)）
// がそれぞれ固定している。ここは「window.confirm へ退行していないか」を3ファイル横断で
// まとめて固定する（掟10: 2026-08-20 の教訓「呼び出しの側を一意に指す・mustNot で直す前の形も見る」）。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const rollbackSection = read('src/renderer/components/RollbackSection.tsx')
const sidebar = read('src/renderer/components/Sidebar.tsx')
const dedicatedPanel = read('src/renderer/components/AppRunDedicatedPanel.tsx')
const confirmModal = read('src/renderer/components/ConfirmModal.tsx')
const useConfirmSrc = read('src/renderer/useConfirm.tsx')

describe('ConfirmModal.tsx: Koto 様式の確認ダイアログ（唯一の定義）', () => {
  it('open/title/body/confirmLabel/cancelLabel/danger/onConfirm/onCancel の props を持つ', () => {
    expect(confirmModal).toContain('open: boolean')
    expect(confirmModal).toContain('title: string')
    expect(confirmModal).toContain('body: string')
    expect(confirmModal).toContain('confirmLabel?: string')
    expect(confirmModal).toContain('cancelLabel?: string')
    expect(confirmModal).toContain('danger?: boolean')
    expect(confirmModal).toContain('onConfirm: () => void')
    expect(confirmModal).toContain('onCancel: () => void')
  })

  it('open=false のときは何も描画しない', () => {
    expect(confirmModal).toContain('if (!open) return null')
  })

  it('本文は select-text（掟5: エラー・確認文言は選択・コピー可能に）', () => {
    expect(confirmModal).toContain('select-text')
  })

  it('danger のときは赤枠（AppRunPanel の破棄確認と同じ border-brand-red 系）', () => {
    expect(confirmModal).toContain('border-brand-red/70')
  })
})

describe('useConfirm.tsx: window.confirm の代わりに Promise<boolean> を返すフック', () => {
  it('confirm と element を返す（confirm は Promise<boolean>）', () => {
    expect(useConfirmSrc).toContain('export function useConfirm() {')
    expect(useConfirmSrc).toContain('const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {')
    expect(useConfirmSrc).toContain('return { confirm, element }')
  })

  it('resolveConfirm（判断だけの純関数）を export している（RTL が無いための変異試験用）', () => {
    expect(useConfirmSrc).toContain("export function resolveConfirm(choice: 'confirm' | 'cancel'): boolean {")
    expect(useConfirmSrc).toContain('return choice === ')
  })
})

describe('RollbackSection.tsx: window.confirm → ConfirmModal', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(rollbackSection).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(rollbackSection).toContain("import { useConfirm } from '../useConfirm'")
    expect(rollbackSection).toContain('{confirmElement}')
  })
})

describe('Sidebar.tsx: window.confirm → ConfirmModal（ファイル移動・ゴミ箱移動の両方。UX-B2 で対象化）', () => {
  it('moveEntry（ファイル移動）の window.confirm は無くなっている', () => {
    const at = sidebar.indexOf('const moveEntry = async (entry: FileEntry) => {')
    expect(at).toBeGreaterThan(-1)
    const end = sidebar.indexOf('\n  }\n', at)
    expect(sidebar.slice(at, end)).not.toContain('window.confirm(')
  })
  it('deleteEntry（ゴミ箱移動）の window.confirm も無くなっている（2026-09-11 UX-B2 で対象化。moveEntry と同じ confirm を共有）', () => {
    const at = sidebar.indexOf('const deleteEntry = async (entry: FileEntry) => {')
    expect(at).toBeGreaterThan(-1)
    const end = sidebar.indexOf('\n  }\n', at)
    const block = sidebar.slice(at, end)
    expect(block).not.toContain('window.confirm(')
    expect(block).toContain('const ok = await confirm(')
    // 確認より前に実行（ゴミ箱への移動）が来ていないか（掟10）
    expect(block.indexOf('const ok = await confirm(')).toBeLessThan(block.indexOf('window.electronAPI.fs.trash'))
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(sidebar).toContain("import { useConfirm } from '../useConfirm'")
    expect(sidebar).toContain('{confirmElement}')
  })
})

describe('AppRunDedicatedPanel.tsx: window.confirm → ConfirmModal（⑤作成・⑥破棄）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(dedicatedPanel).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(dedicatedPanel).toContain("import { useConfirm } from '../useConfirm'")
    expect(dedicatedPanel).toContain('const { confirm, element: confirmElement } = useConfirm()')
    expect(dedicatedPanel).toContain('{confirmElement}')
  })
})

// ── UX-B2（2026-09-11）: 残る10箇所 + useAiChat.ts の1箇所を ConfirmModal（useConfirm）へ置き換え ──
// 上の3ファイル（RollbackSection・Sidebar・AppRunDedicatedPanel）と同じ形で、以下も固定する。

const editorPanel = read('src/renderer/components/EditorPanel.tsx')
const workflowBar = read('src/renderer/components/WorkflowBar.tsx')
const appRunPanel = read('src/renderer/components/AppRunPanel.tsx')
const chatPanel = read('src/renderer/components/ChatPanel.tsx')
const chatApp = read('src/renderer/components/ChatApp.tsx')
const unusedFilesSection = read('src/renderer/components/UnusedFilesSection.tsx')
const credentialsModal = read('src/renderer/components/CredentialsModal.tsx')
const useAiChatSrc = read('src/renderer/hooks/useAiChat.ts')

describe('EditorPanel.tsx: window.confirm → ConfirmModal（未保存タブを閉じる確認）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(editorPanel).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(editorPanel).toContain("import { useConfirm } from '../useConfirm'")
    expect(editorPanel).toContain('{confirmElement}')
  })
})

describe('WorkflowBar.tsx: window.confirm → ConfirmModal（ツール／Homebrew インストール確認・2箇所）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(workflowBar).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(workflowBar).toContain("import { useConfirm } from '../useConfirm'")
    expect(workflowBar).toContain('{confirmElement}')
  })
})

describe('AppRunPanel.tsx: window.confirm → ConfirmModal（cleanUnusedImages）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(appRunPanel).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している（apply/teardown 用の confirm state とは別名 confirmDialog を使う）', () => {
    expect(appRunPanel).toContain("import { useConfirm } from '../useConfirm'")
    expect(appRunPanel).toContain('const { confirm: confirmDialog, element: confirmElement } = useConfirm()')
    expect(appRunPanel).toContain('{confirmElement}')
  })
})

describe('ChatPanel.tsx: window.confirm → ConfirmModal（会話の全削除・useAiChat への confirm 注入）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(chatPanel).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(chatPanel).toContain("import { useConfirm } from '../useConfirm'")
    expect(chatPanel).toContain('{confirmElement}')
  })
  it('useAiChat へ confirm をそのまま渡している（会話削除用と同じインスタンスを共有）', () => {
    const at = chatPanel.indexOf('const chat = useAiChat({')
    expect(at).toBeGreaterThan(-1)
    const end = chatPanel.indexOf('\n  })\n', at)
    expect(chatPanel.slice(at, end)).toContain('\n    confirm,')
  })
})

describe('ChatApp.tsx: window.confirm → ConfirmModal（会話の削除・useAiChat への confirm 注入）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(chatApp).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(chatApp).toContain("import { useConfirm } from '../useConfirm'")
    expect(chatApp).toContain('{confirmElement}')
  })
  it('useAiChat へ confirm をそのまま渡している（会話削除用と同じインスタンスを共有）', () => {
    const at = chatApp.indexOf('const chat = useAiChat({')
    expect(at).toBeGreaterThan(-1)
    const end = chatApp.indexOf('\n  })\n', at)
    expect(chatApp.slice(at, end)).toContain('\n    confirm,')
  })
})

describe('UnusedFilesSection.tsx: window.confirm → ConfirmModal（move）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(unusedFilesSection).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(unusedFilesSection).toContain("import { useConfirm } from '../useConfirm'")
    expect(unusedFilesSection).toContain('{confirmElement}')
  })
})

describe('CredentialsModal.tsx: window.confirm → ConfirmModal（requestClose・VPS鍵の消去）', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(credentialsModal).not.toContain('window.confirm(')
  })
  it('useConfirm を import し、confirmElement を描画している', () => {
    expect(credentialsModal).toContain("import { useConfirm } from '../useConfirm'")
    expect(credentialsModal).toContain('{confirmElement}')
  })
})

// ── UX-B3（2026-09-11・委譲仕様）─────────────────────────────────────────────
// UX-B2 で ConfirmModal 化した10箇所のうち、元に戻せない5操作（会話の全削除・会話の削除・
// 未保存タブを破棄して閉じる・未保存の認証情報編集を破棄・VPSの鍵を消去）は、
// 「confirm が false なら実行しない」という歯止めがコンポーネントの中に
// `if (!ok) return` という**文字列**でしか存在せず、`if (false && !ok) return` に変異させても
// 上のテスト（`window.confirm( を含まない`・`{confirmElement} を描画`）は素通りした
// （担当の申告・2026-09-11）。ここでは歯止めそのものを src/renderer/confirmedActions.ts の
// 純関数（runClearConversation 等）へ切り出し、振る舞い自体は tests/confirmedActions.test.ts が
// 偽の confirm/実行関数で固定する。このテストは「各コンポーネントが実際にその関数を通しているか」
// （呼び出しの形ごと・2026-08-20 の教訓どおり前後を含めて一意に指す）だけを固定する。

describe('ChatPanel.tsx: 会話の全削除は runClearConversation を通す（UX-B3）', () => {
  it('クリアボタンの onClick は runClearConversation( を呼び、旧来の直書きゲートは無い', () => {
    const at = chatPanel.indexOf('if (messages.filter(m => !m.hidden).length === 0) return')
    expect(at).toBeGreaterThan(-1)
    const end = chatPanel.indexOf('title="会話をクリア"', at)
    expect(end).toBeGreaterThan(at)
    const block = chatPanel.slice(at, end)
    expect(block).toContain('await runClearConversation(')
    // UX-B2 当時の「答えを無視する変異」を素通りさせた直書きゲートが戻っていないこと。
    expect(block).not.toContain('if (!ok) return')
    expect(block).not.toContain('const ok = await confirm(')
  })
  it('confirmedActions.ts から runClearConversation を import している', () => {
    expect(chatPanel).toContain("import { runClearConversation } from '../confirmedActions'")
  })
})

describe('ChatApp.tsx: 会話の削除は runDeleteConversation を通す（UX-B3・完了条件の変異試験(c)）', () => {
  it('deleteSession は runDeleteConversation( を呼び、旧来の直書きゲートは無い', () => {
    const at = chatApp.indexOf('const deleteSession = async (id: string) => {')
    expect(at).toBeGreaterThan(-1)
    const end = chatApp.indexOf('\n  }\n', at)
    expect(end).toBeGreaterThan(at)
    const block = chatApp.slice(at, end)
    expect(block).toContain('await runDeleteConversation(')
    // 変異(c): runDeleteConversation を通さず、convClientsRef.current.delete(id) 等を
    // このブロックで直接（confirm を待たずに）呼ぶ形に戻すと、この行が無くなって落ちる。
    expect(block).not.toContain('if (!(await confirm(')
    expect(block).not.toContain('if (!ok) return')
  })
  it('confirmedActions.ts から runDeleteConversation を import している', () => {
    expect(chatApp).toContain("import { runDeleteConversation } from '../confirmedActions'")
  })
})

describe('EditorPanel.tsx: 未保存タブを閉じるのは runCloseUnsaved を通す（UX-B3）', () => {
  it('閉じるボタンの onClick は runCloseUnsaved( を呼び、旧来の直書きゲートは無い', () => {
    const at = editorPanel.indexOf('onClick={async e => {')
    expect(at).toBeGreaterThan(-1)
    const end = editorPanel.indexOf("title={file.isDirty ? '未保存のまま閉じる' : '閉じる'}", at)
    expect(end).toBeGreaterThan(at)
    const block = editorPanel.slice(at, end)
    expect(block).toContain('await runCloseUnsaved(')
    expect(block).not.toContain('if (!ok) return')
    expect(block).not.toContain('const ok = await confirm(')
  })
  it('confirmedActions.ts から runCloseUnsaved を import している', () => {
    expect(editorPanel).toContain("import { runCloseUnsaved } from '../confirmedActions'")
  })
})

describe('CredentialsModal.tsx: 未保存の破棄・VPS鍵の消去は confirmedActions.ts を通す（UX-B3・完了条件の変異試験(b)）', () => {
  it('requestClose は runDiscardCredentialEdits( を呼び、旧来の直書きゲートは無い', () => {
    const at = credentialsModal.indexOf('const requestClose = async () => {')
    expect(at).toBeGreaterThan(-1)
    const end = credentialsModal.indexOf('\n  }\n', at)
    expect(end).toBeGreaterThan(at)
    const block = credentialsModal.slice(at, end)
    expect(block).toContain('await runDiscardCredentialEdits(')
    expect(block).not.toContain('if (!ok) return')
  })
  it('VPS鍵の消去（onClear）は runEraseVpsKey( を呼び、旧来の直書きゲートは無い（変異(b): ok を見ずに clear/erase を呼ぶ形は confirmedActions.test.ts が捕まえる）', () => {
    const at = credentialsModal.indexOf('onClear={async () => {')
    expect(at).toBeGreaterThan(-1)
    const end = credentialsModal.indexOf('\n                />', at)
    expect(end).toBeGreaterThan(at)
    const block = credentialsModal.slice(at, end)
    expect(block).toContain('await runEraseVpsKey(')
    expect(block).not.toContain('if (!(await confirm(')
  })
  it('confirmedActions.ts から runDiscardCredentialEdits・runEraseVpsKey を import している', () => {
    expect(credentialsModal).toContain("import { runDiscardCredentialEdits, runEraseVpsKey } from '../confirmedActions'")
  })
})

describe('useAiChat.ts: window.confirm → ConfirmModal（Claudeモード同意）は「注入」で受け取る', () => {
  it('window.confirm( を一切含まない（ファイル全体）', () => {
    expect(useAiChatSrc).not.toContain('window.confirm(')
  })
  it('confirm を UseAiChatArgs の必須引数として持つ（掟10: 任意にすると渡し忘れに気づけない）', () => {
    expect(useAiChatSrc).toContain('confirm: (opts: ConfirmOptions) => Promise<boolean>')
    expect(useAiChatSrc).not.toContain('confirm?: (opts: ConfirmOptions) => Promise<boolean>')
  })
  it('agreed の判定は await confirm(...) を経由する', () => {
    const at = useAiChatSrc.indexOf('const agreed = await confirm({')
    expect(at).toBeGreaterThan(-1)
  })
})

// ── 新設（完了条件）: src/renderer 配下に window.confirm( が一切無いことを、実際にソースを
// 走査して確かめる（除外リストは持たない・useAiChat.ts も例外なく対象）。失敗時にどのファイルが
// 原因か分かるよう、該当ファイルのパス一覧を assert に含める（掟10: 2026-08-20 の教訓）。
describe('src/renderer 配下に window.confirm( が一切無いこと（全件走査・例外なし）', () => {
  it('offenders は空配列', () => {
    const rendererRoot = path.join(ROOT, 'src/renderer')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (stat.isFile()) {
          const content = fs.readFileSync(full, 'utf-8')
          if (content.includes('window.confirm(')) {
            offenders.push(path.relative(ROOT, full))
          }
        }
      }
    }
    walk(rendererRoot)
    expect(offenders).toEqual([])
  })
})
