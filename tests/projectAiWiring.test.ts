import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 使う AI とモデルの記憶（プロジェクトごと）の配線。ソースを、コメントを外して読み、呼び出しの形ごと見る。
// 当て先が定義や説明に出ないよう、呼び出しの前後ごと書く。直す前の形は not.toContain で禁じる。
// 動きそのものは tests/projectAi*.test.ts（振る舞い）が固定している。ここは「繋がっているか」だけを見る。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
const lineCount = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').split('\n').length

describe('NewProjectModal: 作成で選んだ AI とモデルは、作ったプロジェクトの記憶にだけ書く', () => {
  const src = readCode('src/renderer/components/NewProjectModal.tsx')
  // 振る舞い（古い記憶を消す・既定を書かない）は tests/projectAi.test.ts の applyCreationAi が固定している。ここは繋がっているかだけ。

  it('★★★ 記憶の扱いは applyCreationAi の1行で、onCreated・退避・依頼のイベントより前（同期）', () => {
    const call = src.indexOf('applyCreationAi({ root: result.root, merged: result.merged, useChat, brain, claudeModelId, sakuraModelId })')
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(src.indexOf('onCreated(result.root, openRelPath)'))
    expect(call).toBeLessThan(src.indexOf('stashNewProjectRequest(result.root, prompt)'))
    expect(call).toBeLessThan(src.indexOf("new CustomEvent('sakura-new-project-request'"))
  })

  it('★★★ 保存できなかった（useChat のとき）は、onCreated にも依頼にも進まない', () => {
    const guard = src.indexOf('if (!aiSaved && useChat)')
    expect(guard).toBeGreaterThan(0)
    expect(src.slice(guard, src.indexOf('onCreated(result.root, openRelPath)'))).toContain('return')
  })

  it('★★★ 記憶の書き込みを直接呼ばず、設定の既定を書く関数・鍵も触らない', () => {
    for (const bad of ['setClaudeMode(', 'setClaudeModel(', 'setDefaultModel(', 'rememberProjectAi(', 'forgetProjectAi(', 'sakura_claude_mode', 'sakura_model_ide', 'sakura_claude_model', 'credentials-changed']) {
      expect(src, bad).not.toContain(bad)
    }
  })
})

describe('取り込み・チャットモードの保存で作ったフォルダは、作った時点で古い記憶を消す', () => {
  const imp = readCode('src/renderer/components/ImportFromPublishedPanel.tsx')
  it('★★★ 取り込み: createProject のあと・setDestRoot の前に projectAi の forgetProjectAi(dest)。ボタンは onCreated だけ', () => {
    const create = imp.indexOf('window.electronAPI.fs.createProject(parentDir, n,')
    const forget = imp.indexOf('forgetProjectAi(dest)')
    expect(create).toBeGreaterThan(0)
    expect(forget).toBeGreaterThan(create)
    expect(forget).toBeLessThan(imp.indexOf('setDestRoot(dest)'))
    expect(imp).toContain('onClick={() => onCreated(destRoot)}')
    expect(imp).toContain("import { forgetProjectAi } from '../projectAi'")
    expect(imp).not.toMatch(/(const|function) forgetProjectAi/)
  })
  it('★★★ チャットモードの保存: created のときだけ、onApplyFile の前に forgetProjectAi(r.projectDir)', () => {
    const chat = readCode('src/renderer/components/ChatApp.tsx')
    const forget = chat.indexOf('if (r.created) forgetProjectAi(r.projectDir)')
    expect(forget).toBeGreaterThan(0)
    expect(forget).toBeLessThan(chat.indexOf('await onApplyFile(relPath, content'))
    expect(chat).toContain("import { forgetProjectAi } from '../projectAi'")
  })
})

describe('古い言い方が残っていない（コメント・文書）', () => {
  // 行の折り返しをまたいでも見つかるよう、改行と行頭のコメント記号を落として読む
  const flat = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').replace(/\n\s*(\/\/|\*)?\s*/g, '')
  it('「初めてのプロジェクト作成」では ChatPanel がマウントされていない、という誤りを書かない', () => {
    for (const f of ['src/renderer/newProjectRequest.ts', 'src/renderer/components/ChatPanel.tsx', 'src/renderer/components/NewProjectModal.tsx']) {
      expect(flat(f), f).not.toContain('「初めてのプロジェクト作成」では')
    }
  })
  it('setClaudeMode の説明が、唯一の書き込み口・頭脳の表示を言い切らない', () => {
    const t = flat('src/renderer/claudeMode.ts')
    expect(t).not.toContain('唯一の書き込み口')
    expect(t).toContain('notifyAiChoiceChanged（aiChoiceSignal）で描き直す')
  })
  it('CHANGELOG: Claude の確認は「まだのときは出る」「すべてのプロジェクトで共通」と言う', () => {
    const t = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
    expect(t).not.toContain('初めて送るときは、これまでどおり Claude の利用の確認が出ます')
    expect(t).toContain('Claude の利用の確認がまだのときは、送る前に出ます。確認はすべてのプロジェクトで共通です')
  })
  it('README: モデルの記憶は新規作成で選んだものも含む', () => {
    const t = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8')
    expect(t).not.toMatch(/(^|[^や])チャット欄の上で選んだモデルは、そのプロジェクトで覚えます/)
    expect(t).toContain('新規作成やチャット欄の上で選んだモデルは、そのプロジェクトで覚えます。どちらでも選んでいないプロジェクトは')
  })
})

describe('ChatPanel: 使う AI とモデルは useProjectAiChoice から受け取り、設定の既定を読み書きしない', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')
  it('★★★ 既定を書く・読む直す前の形が無い', () => {
    for (const bad of ['setClaudeModel(', 'setDefaultModel(', 'isClaudeModeEnabled(', 'getClaudeModel(', 'useState(getDefaultModel']) {
      expect(src, bad).not.toContain(bad)
    }
  })
  it('★★★ フックの呼び出しの形と、案内の画面の切り出し', () => {
    expect(src).toContain('useProjectAiChoice({ projectDir: projectDir ?? null, apiKey, convLoadedDir, applyOp })')
    expect(src).toContain('<ChatKeyMissing onOpenCredentials={onOpenCredentials} onUseClaudeHere={ai.switchToClaudeHere ?? undefined} />')
  })
  it('ChatPanel の行数が減っている（節を切り出した）', () => {
    expect(lineCount('src/renderer/components/ChatPanel.tsx')).toBeLessThan(1325)
  })
})

describe('BrainToggle: 切り替えは、そのプロジェクトの記憶だけ', () => {
  const src = readCode('src/renderer/components/BrainToggle.tsx')
  it('★★★ 既定を書く・読む関数を呼ばない', () => {
    expect(src).not.toContain('setClaudeMode(')
    expect(src).not.toContain('isClaudeModeEnabled(')
  })
  it('★★ 押したときの書き込みは applyBrainToggle を通る（振る舞いは tests/brainToggle.test.ts）', () => {
    expect(src).toContain('applyBrainToggle({ projectDir, canToggle, current })')
    expect(src).toContain('rememberProjectBrain(a.dir, a.brain)')
  })
})

describe('useAiChat: 送る回の AI とモデルは、送った瞬間に1回だけ読んで固定する', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')
  it('★★★ 既定を書く・読む直す前の形が無い', () => {
    for (const bad of ['setClaudeMode(', 'getClaudeModel(', 'isClaudeModeEnabled(']) expect(src, bad).not.toContain(bad)
  })
  it('★★★ aiAtSend の読み込みが、キーを読む await より前（コメントを外して読む）', () => {
    const at = src.indexOf('const aiAtSend = aiChoiceInputsNow(toolsProjectDir)')
    const token = src.indexOf('await getAnthropicToken()')
    expect(at).toBeGreaterThan(0)
    expect(token).toBeGreaterThan(0)
    expect(at).toBeLessThan(token)
  })
  it('★★ Claude のモデルは引数で渡し、さくらのモデルも固定した値を使う', () => {
    expect(src).toContain('delegateKey, ai.claudeModel,')
    expect(src).toContain('model: toolsProjectDir ? ai.sakuraModel : model,')
    expect(src).toContain('const ai = resolveAiChoice({ ...aiAtSend, hasClaudeKey: !!claudeKey, hasEngineKey: !!apiKey })')
  })
  it('★★ 「切り替えて続ける」は、回のプロジェクトの記憶だけを書く', () => {
    expect(src).toContain("if (toolsProjectDir) rememberProjectBrain(toolsProjectDir, 'sakura')")
  })
})

describe("'sakura-usage-changed' を聞かない（利用の記録のたびに出るため）", () => {
  for (const f of [
    'src/renderer/components/ChatPanel.tsx',
    'src/renderer/hooks/useProjectAiChoice.ts',
    'src/renderer/components/BrainToggle.tsx',
    'src/renderer/projectAi.ts',
  ]) {
    it(f, () => { expect(readCode(f)).not.toContain('sakura-usage-changed') })
  }
})

describe('projectAi.ts は window の出来事を出さない（公開の画面などを読み直させない）', () => {
  it('dispatchEvent を含まない', () => {
    expect(readCode('src/renderer/projectAi.ts')).not.toContain('dispatchEvent')
  })
})

describe('StatusBar へ開いているプロジェクトを渡す', () => {
  it('App.tsx の呼び出し', () => {
    expect(readCode('src/renderer/App.tsx')).toContain('<StatusBar activeFile={activeFileObj} meta={projectMeta} apiKey={sakuraApiKey} projectDir={currentDir} />')
  })
})

describe('切り出したファイルは 400 行以下', () => {
  for (const f of ['src/renderer/hooks/useProjectAiChoice.ts', 'src/renderer/components/ChatKeyMissing.tsx', 'src/renderer/projectAi.ts']) {
    it(f, () => { expect(lineCount(f)).toBeLessThanOrEqual(400) })
  }
})

describe('設定: Claude の既定のモデルの欄は、設定の既定の書き込み口（setClaudeModel）を呼ぶ', () => {
  it('Claude のキーがあるときだけ出し、onChange は setClaudeModel', () => {
    const src = readCode('src/renderer/components/SettingsModal.tsx')
    expect(src).toContain('{hasClaudeKey && (')
    expect(src).toContain('onChange={e => setClaudeModel(e.target.value)}')
    expect(src).toContain('value={getClaudeModel(claudeModels)}')
  })
})
