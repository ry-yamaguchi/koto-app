import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// B-1b: 実行状態（考えています…・⏹・入力欄のロック・routedModel）をプロジェクト別にする配線の固定。
// 中身の振る舞い（鍵ごとの独立・通知・resetTurn）は tests/chatTurnRegistry.test.ts で検証済み。
// ここは「その置き場が実際に配線されているか」を useAiChat.ts / ChatPanel.tsx / Sidebar.tsx の
// ソースに対して確かめる（readCode 方式。既存の tests/chatEvents.test.ts 等と同じ流儀）。
//
// ⚠️ コメントを外してから判定する（2026-08-20 に自分の説明コメントにテストが当たって落ちた事故の
// 再発防止。他の readCode テストと同じ流儀）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('useAiChat.ts の配線（B-1b: 実行状態を registry から読む）', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('isLoading/statusNote/routedModel の useState が無い（registry から読む）', () => {
    expect(src).not.toContain('const [isLoading, setIsLoading] = useState')
    expect(src).not.toContain("const [statusNote, setStatusNote] = useState")
    expect(src).not.toContain('const [routedModel, setRoutedModel] = useState')
  })

  it('abortRef が無い（⏹ の登録は registry の updateTurn(key, { abort }) に変わった）', () => {
    expect(src).not.toContain('abortRef')
  })

  it('lastActivityRef が無い（活動通知は registry の updateTurn(key, { lastActivityAt }) に変わった）', () => {
    expect(src).not.toContain('lastActivityRef')
  })

  it('emit / viewOnlyEmit の scalar 分岐は updateTurn(key, … ) / resetTurn(key) を通る', () => {
    for (const name of ['emit', 'viewOnlyEmit'] as const) {
      const start = src.indexOf(`const ${name} = useCallback(`)
      expect(start).toBeGreaterThan(-1)
      const m = /\n {2}\}, \[[^\]]*\]\)/.exec(src.slice(start))
      expect(m).not.toBeNull()
      const block = src.slice(start, start + m!.index + m![0].length)
      expect(block).toContain('const key = turnKey(toolsProjectDir)')
      expect(block).toContain("updateTurn(key, { isLoading: true, startedAt: Date.now(), lastActivityAt: Date.now() })")
      expect(block).toContain('resetTurn(key)')
      expect(block).toContain("updateTurn(key, { statusNote: ev.value })")
      expect(block).toContain("updateTurn(key, { routedModel: ev.value })")
    }
  })

  // ── send() は冒頭で鍵を固定し、以後はその key を使い続ける ────────────────────
  //
  // なぜこれが要るか: send() の中身は非同期（await が並ぶ）。その間に利用者が別の
  // プロジェクトへ切り替えると toolsProjectDir（props）は新しい値に変わる。もし ⏹ の登録・
  // 活動通知のたびに turnKey(toolsProjectDir) を**その都度**呼んでいたら、切替後は
  // 新しいプロジェクトの鍵に書いてしまう（turnOpts を送信時に固定するのと同じ理由で壊れる）。
  // 「send() の本体の中で turnKey(toolsProjectDir) の呼び出しが1回だけ」であることを固定する
  // （2回以上あれば、どこかで「その都度」読み直す壊し方に戻っている）。
  it('send() の本体は turnKey(toolsProjectDir) を1回だけ呼び、以後は key を使い回す', () => {
    const start = src.indexOf('const send = useCallback(')
    expect(start).toBeGreaterThan(-1)
    // send() の依存配列は複数行（`}, [\n    isLoading, ...`）なので、他の useCallback（1行で
    // 閉じる）と区別できるこの形で終わりを探す。
    const end = src.indexOf('\n  }, [\n', start)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    const occurrences = body.split('turnKey(toolsProjectDir)').length - 1
    expect(occurrences).toBe(1)
    expect(body).toContain('const key = turnKey(toolsProjectDir)')
    // 固定した key を、⏹ 登録・活動通知・buildPorts の3か所で使い回している
    expect(body).toContain('updateTurn(key, { abort: () => { void window.electronAPI.chatTurn.abort(turnId) } })')
    expect(body).toContain('onActivity: () => { updateTurn(key, { lastActivityAt: Date.now() }) }')
    expect(body).toContain('buildPorts(key)')
  })

  it('sendViaClaude・compactNow も、それぞれ呼び出し時点の鍵を1回だけ作って使い回す', () => {
    // sendViaClaude: 引数の projectDir から作る（send() 側が「送信した瞬間の toolsProjectDir」を渡す）
    const svcStart = src.indexOf('const sendViaClaude = useCallback(')
    const svcEnd = src.indexOf('const send = useCallback(', svcStart)
    expect(svcStart).toBeGreaterThan(-1)
    expect(svcEnd).toBeGreaterThan(svcStart)
    const svcBody = src.slice(svcStart, svcEnd)
    expect(svcBody.split('turnKey(projectDir)').length - 1).toBe(1)
    expect(svcBody).toContain('updateTurn(key, { lastActivityAt: Date.now() })')
    expect(svcBody).toContain('abort: () => {')

    // compactNow: フックの toolsProjectDir から作る
    const cnStart = src.indexOf('const compactNow = useCallback(')
    const cnEnd = src.indexOf('const sendViaClaude = useCallback(', cnStart)
    expect(cnStart).toBeGreaterThan(-1)
    expect(cnEnd).toBeGreaterThan(cnStart)
    const cnBody = src.slice(cnStart, cnEnd)
    expect(cnBody.split('turnKey(toolsProjectDir)').length - 1).toBe(1)
    expect(cnBody).toContain('buildPorts(key)')
  })

  it('setRoutedModel は updateTurn(turnKey(toolsProjectDir), { routedModel }) の包み', () => {
    expect(src).toContain('const setRoutedModel = useCallback((value: string | null) => {')
    expect(src).toContain('updateTurn(turnKey(toolsProjectDir), { routedModel: value })')
  })

  it('abort() は「いま見ているプロジェクト」の登録を呼ぶ（getTurn(viewKey).abort?.()）', () => {
    expect(src).toContain('const abort = useCallback(() => { getTurn(viewKey).abort?.() }, [viewKey])')
  })
})

describe('ChatPanel.tsx の配線（B-1b: 切替時に routedModel をリセットしない）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('プロジェクト読み込みの effect（projectDir 切替のたび）に setRoutedModel(null) が無い', () => {
    const at = src.indexOf('clientRef.current = null')
    expect(at).toBeGreaterThan(-1)
    const end = src.indexOf('}, [projectDir, applyOpLocally])', at)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).not.toContain('setRoutedModel(null)')
  })

  // モデル選択欄からの**手動**切替は、従来どおり割り振りをリセットする
  // （これは「会話が変わったから」ではなく「利用者が別モデルを選んだから」で、意味が異なる。消していない）。
  it('モデル選択欄からの手動切替では、従来どおり setRoutedModel(null) を呼ぶ', () => {
    expect(src).toContain("setModel(id); setDefaultModel(id, 'ide'); setRoutedModel(null)")
  })
})

describe('Sidebar.tsx の配線（B-1b: ⏳ の印）', () => {
  const src = readCode('src/renderer/components/Sidebar.tsx')

  it('chatTurnRegistry を購読している', () => {
    expect(src).toContain("import { subscribe, getSnapshot, loadingKeys } from '../chatTurnRegistry'")
    expect(src).toContain('useSyncExternalStore(subscribe, getSnapshot)')
    expect(src).toContain('const loadingProjects = new Set(loadingKeys())')
  })

  it('現在のプロジェクト名の行に ⏳ を出す条件がある', () => {
    expect(src).toContain('{loadingProjects.has(currentDir) && <span className="flex-none text-[11px]" title="AIが作業中です">⏳</span>}')
  })

  it('プロジェクト切替メニューの行（ワークスペース一覧・最近開いた場所）に ⏳ を出す条件がある', () => {
    const count = src.split('{loadingProjects.has(p) && <span className="flex-none text-[11px]" title="AIが作業中です">⏳</span>}').length - 1
    expect(count).toBe(2) // workspaceProjects.map と recents.map の2か所
  })
})

// ── 承認待ちの列（B-1b の並列解禁に伴う守り）─────────────────────────────
// 並列で2つのターンが同時に承認を求めると、単一スロットでは2件目が1件目の resolve を
// 握りつぶし、1件目のターンが永遠にハングする。列であることをソースで固定する。
describe('ChatPanel: 承認待ちが列になっている', () => {
  it('pendingApprovals（配列）を使い、単一スロットの setPendingApproval( が残っていない', () => {
    const src = readCode('src/renderer/components/ChatPanel.tsx')
    expect(src).toContain('const [pendingApprovals, setPendingApprovals] = useState<Array<')
    // 追記と先頭抜きは**2か所ずつ**（ファイル保存・コマンド実行）。toContain だと片方が
    // 単一スロットに戻っても通ってしまう（ミューテーション試験で実際に素通りした）ので数で固定する
    const count = (needle: string) => src.split(needle).length - 1
    expect(count('setPendingApprovals(prev => [...prev, {')).toBe(2)
    expect(count('setPendingApprovals(prev => prev.slice(1))')).toBe(2)
    expect(src).not.toContain('setPendingApproval(')
  })
})

