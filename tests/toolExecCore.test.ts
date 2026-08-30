import { describe, it, expect } from 'vitest'
import { executeToolCore, type CoreToolContext, type ToolIo } from '../src/shared/toolExecCore'

// executeToolCore（B'-3d-2a で renderer/aiTools.ts から切り出した本体）を、偽の io を
// 差し込んで直接駆動する。ここでの目的は「本体を移しても文言・判定順序が一字一句変わって
// いないこと」を固定すること（tests/aiToolsApply.test.ts が皮側から同じ結論を確かめている）。

/** 未使用のはずの io メソッドを呼んだら分かるようにする（意図しない呼び出しを見逃さないため）。 */
function notImplemented(name: string) {
  return async (..._args: any[]): Promise<any> => {
    throw new Error(`想定外の呼び出し: io.${name}`)
  }
}

function makeIo(overrides: Partial<ToolIo> = {}): ToolIo {
  return {
    fetchPage: notImplemented('fetchPage'),
    webSearch: notImplemented('webSearch'),
    projectFiles: notImplemented('projectFiles'),
    readFileInProject: notImplemented('readFileInProject'),
    writeFileInProject: notImplemented('writeFileInProject'),
    snapshotBeforeWrite: async () => ({ ok: false, backedUp: false }),
    runCommand: notImplemented('runCommand'),
    searchInProject: notImplemented('searchInProject'),
    exists: notImplemented('exists'),
    openPath: notImplemented('openPath'),
    ...overrides,
  }
}

describe('executeToolCore - 共通のエラー文言', () => {
  it('引数JSONが不正なら文言を返す（ツール名に関わらず最初に判定される）', async () => {
    const result = await executeToolCore('write_file', '{not json', {}, makeIo())
    expect(result).toBe('エラー: ツール引数のJSONが不正です')
  })

  it('未対応のツール名はその名前を含めて返す', async () => {
    const result = await executeToolCore('bogus_tool', '{}', {}, makeIo())
    expect(result).toBe('エラー: 未対応のツールです（bogus_tool）')
  })

  it.each(['list_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'search_in_files', 'open_preview'])(
    '%s: writeRoot が無ければ「プロジェクトが開かれていません」',
    async (name) => {
      const result = await executeToolCore(name, '{}', {}, makeIo())
      expect(result).toBe('エラー: プロジェクトが開かれていません')
    }
  )

  it('read_file: 不正なパス（脱出）はエラー文言に相対パス指定を促す', async () => {
    const ctx: CoreToolContext = { writeRoot: '/w' }
    const result = await executeToolCore('read_file', JSON.stringify({ path: '../secret' }), ctx, makeIo())
    expect(result).toBe('エラー: 不正なパスです（../secret）。プロジェクトルートからの相対パスを指定してください')
  })

  it('write_file: Koto管理領域（.env）は保護パス文言を返す', async () => {
    const ctx: CoreToolContext = { writeRoot: '/w' }
    const result = await executeToolCore('write_file', JSON.stringify({ path: '.env', content: 'x' }), ctx, makeIo())
    expect(result).toBe('エラー: .env は Koto が管理する領域のため書き込めません（履歴・設定・.git・秘密情報のファイル）。ユーザーの作業ファイルを対象にしてください。')
  })
})

describe('executeToolCore - write_file', () => {
  it('io.applyFile がある道: (rel, content, writeRoot) で呼ばれ、バックアップは projectRoot 優先・backupRelPath 経由の rel で呼ばれる', async () => {
    const calls: any[] = []
    const io = makeIo({
      applyFile: async (rel, content, root) => { calls.push({ fn: 'applyFile', rel, content, root }) },
      snapshotBeforeWrite: async (root, snapshotId, rel, newContent, label) => {
        calls.push({ fn: 'snapshotBeforeWrite', root, snapshotId, rel, newContent, label })
        return { ok: true, backedUp: true }
      },
    })
    const ctx: CoreToolContext = { writeRoot: '/w/public', projectRoot: '/w', snapshotId: 'SID', snapshotLabel: 'ラベル' }
    const result = await executeToolCore('write_file', JSON.stringify({ path: 'a.txt', content: 'hello' }), ctx, io)
    expect(result).toBe(
      '保存しました: a.txt（5文字）' +
      '（旧内容は自動バックアップ済み。ユーザーに「元に戻して」と言われたら、画面上部の「🕘 元に戻す」から、その時点の状態にまるごと戻せることを案内してください）'
    )
    expect(calls).toEqual([
      { fn: 'snapshotBeforeWrite', root: '/w', snapshotId: 'SID', rel: 'public/a.txt', newContent: 'hello', label: 'ラベル' },
      { fn: 'applyFile', rel: 'a.txt', content: 'hello', root: '/w/public' },
    ])
  })

  it('io.applyFile が無い道: writeFileInProject が (writeRoot, rel, content) で呼ばれ、バックアップ無しなら注記が付かない', async () => {
    const calls: any[] = []
    const io = makeIo({
      writeFileInProject: async (root, rel, content) => { calls.push({ root, rel, content }) },
    })
    const ctx: CoreToolContext = { writeRoot: '/w' }
    const result = await executeToolCore('write_file', JSON.stringify({ path: 'a.txt', content: 'hi' }), ctx, io)
    expect(result).toBe('保存しました: a.txt（2文字）')
    expect(calls).toEqual([{ root: '/w', rel: 'a.txt', content: 'hi' }])
  })
})

describe('executeToolCore - edit_file', () => {
  const ctx: CoreToolContext = { writeRoot: '/w' }

  it('not-found: 一致無し', async () => {
    const io = makeIo({ readFileInProject: async () => 'before' })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: 'zzz', new_string: 'y' }), ctx, io)
    expect(result).toBe(
      'エラー: 指定された文字列が見つかりません（a.txt）。read_file で現在の内容を確認してから、実際にファイル内にある文字列を old_string に指定してください（推測で再試行しないこと）'
    )
  })

  it('ambiguous: 複数一致・replace_all未指定', async () => {
    const io = makeIo({ readFileInProject: async () => 'foo foo foo' })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }), ctx, io)
    expect(result).toBe(
      'エラー: 指定された文字列が 3 箇所にあります（a.txt）。周囲の行を含めて old_string がファイル内で一意になるよう広げるか、replace_all: true を指定してください'
    )
  })

  it('empty-old: old_string が空', async () => {
    const io = makeIo({ readFileInProject: async () => 'before' })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: '', new_string: 'y' }), ctx, io)
    expect(result).toBe('エラー: old_string が空です。置き換えたい既存の文字列を指定してください')
  })

  it('same: old_string と new_string が同じ', async () => {
    const io = makeIo({ readFileInProject: async () => 'before' })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: 'x', new_string: 'x' }), ctx, io)
    expect(result).toBe('エラー: old_string と new_string が同じです（変更内容がありません）')
  })

  it('成功: 置換件数入りの完了文言（バックアップ注記つき）', async () => {
    const io = makeIo({
      readFileInProject: async () => 'const a = 1',
      writeFileInProject: async () => {},
      snapshotBeforeWrite: async () => ({ ok: true, backedUp: true }),
    })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: 'a = 1', new_string: 'a = 2' }), ctx, io)
    expect(result).toBe(
      '編集しました: a.txt（1箇所を置換）' +
      '（旧内容は自動バックアップ済み。ユーザーに「元に戻して」と言われたら、画面上部の「🕘 元に戻す」から、その時点の状態にまるごと戻せることを案内してください）'
    )
  })

  it('read_file 相当の読み込みに失敗した場合の案内文', async () => {
    const io = makeIo({ readFileInProject: async () => { throw new Error('boom') } })
    const result = await executeToolCore(
      'edit_file', JSON.stringify({ path: 'a.txt', old_string: 'x', new_string: 'y' }), ctx, io)
    expect(result).toBe(
      'エラー: ファイルを読めませんでした（boom）。先に read_file で現在の内容を確認するか、新規作成なら write_file を使ってください'
    )
  })
})

describe('executeToolCore - read_file の打ち切り（READ_MAX_CHARS = 16000）', () => {
  const ctx: CoreToolContext = { writeRoot: '/w' }

  it('16000文字を超えると打ち切り、全体の文字数を案内する', async () => {
    const long = 'x'.repeat(20000)
    const io = makeIo({ readFileInProject: async () => long })
    const result = await executeToolCore('read_file', JSON.stringify({ path: 'a.txt' }), ctx, io)
    expect(result).toBe(
      `ファイル: a.txt\n\n${long.slice(0, 16000)}\n\n（長いため 16000 文字で打ち切り。全体は 20000 文字）`
    )
  })

  it('16000文字以下なら打ち切り注記は付かない', async () => {
    const short = 'hello'
    const io = makeIo({ readFileInProject: async () => short })
    const result = await executeToolCore('read_file', JSON.stringify({ path: 'a.txt' }), ctx, io)
    expect(result).toBe('ファイル: a.txt\n\nhello')
  })
})

describe('executeToolCore - search_web', () => {
  it('ctx.search が無いときの案内文', async () => {
    const result = await executeToolCore('search_web', JSON.stringify({ query: 'q' }), {}, makeIo())
    expect(result).toBe('エラー: Web検索のAPIキーが未設定です（ユーザーに認証情報（⇧⌘,）でのTavilyまたはBraveのキー登録を案内してください）')
  })

  it('結果0件', async () => {
    const ctx: CoreToolContext = { search: { provider: 'tavily', key: 'k' } }
    const io = makeIo({ webSearch: async () => [] })
    const result = await executeToolCore('search_web', JSON.stringify({ query: 'q' }), ctx, io)
    expect(result).toBe('「q」の検索結果はありませんでした')
  })

  it('結果ありは wrapUntrusted で境界を付けて整形される', async () => {
    const ctx: CoreToolContext = { search: { provider: 'tavily', key: 'k' } }
    const io = makeIo({
      webSearch: async () => [{ title: 'T1', url: 'https://a', description: 'D1' }],
    })
    const result = await executeToolCore('search_web', JSON.stringify({ query: 'q' }), ctx, io)
    expect(result.startsWith('「q」の検索結果:\n\n')).toBe(true)
    expect(result).toContain('<<<KOTO-EXT-')
    expect(result).toContain('Web検索結果（クエリ: "q"）')
    expect(result).toContain('1. T1\n   https://a\n   D1')
    expect(result.endsWith('\n\n（詳細が必要なページは fetch_url で本文を取得できます）')).toBe(true)
  })
})

describe('executeToolCore - search_docs', () => {
  it('io.ragSearch が無いときの案内文', async () => {
    const result = await executeToolCore('search_docs', JSON.stringify({ query: 'q' }), {}, makeIo())
    expect(result).toBe('資料検索は現在利用できません')
  })

  it('結果が空文字なら「見つかりませんでした」', async () => {
    const io = makeIo({ ragSearch: async () => '' })
    const result = await executeToolCore('search_docs', JSON.stringify({ query: 'q' }), {}, io)
    expect(result).toBe('該当する資料が見つかりませんでした')
  })

  it('結果があればそのまま返す', async () => {
    const io = makeIo({ ragSearch: async () => '本文そのまま' })
    const result = await executeToolCore('search_docs', JSON.stringify({ query: 'q' }), {}, io)
    expect(result).toBe('本文そのまま')
  })
})

describe('executeToolCore - run_command', () => {
  const ctx: CoreToolContext = { writeRoot: '/w' }

  it('コマンドが空なら文言を返す', async () => {
    const result = await executeToolCore('run_command', JSON.stringify({ command: '  ' }), ctx, makeIo())
    expect(result).toBe('エラー: コマンドが空です')
  })

  it('終了コード・stdout/stderrを整形する', async () => {
    const io = makeIo({
      runCommand: async () => ({ code: 1, stdout: 'out', stderr: 'err', timedOut: false }),
    })
    const result = await executeToolCore('run_command', JSON.stringify({ command: 'echo hi' }), ctx, io)
    expect(result).toBe('$ echo hi\n終了コード: 1\n--- stdout ---\nout\n--- stderr ---\nerr\n')
  })

  it('出力が無ければ「（出力なし）」', async () => {
    const io = makeIo({
      runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    })
    const result = await executeToolCore('run_command', JSON.stringify({ command: 'true' }), ctx, io)
    expect(result).toBe('$ true\n終了コード: 0\n（出力なし）')
  })

  it('タイムアウト時は注記が付く', async () => {
    const io = makeIo({
      runCommand: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    })
    const result = await executeToolCore('run_command', JSON.stringify({ command: 'sleep 999' }), ctx, io)
    expect(result).toBe('$ sleep 999\n終了コード: null（60秒でタイムアウト。常駐プロセスはこのツールでは起動できません）\n（出力なし）')
  })
})
