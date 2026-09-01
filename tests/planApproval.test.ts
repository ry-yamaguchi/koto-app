import { describe, it, expect } from 'vitest'
import { planApproval, writeDenialMessage, runCommandDenialMessage } from '../src/shared/approvalPlan'
import { PUBLISH_DIR_LABEL } from '../src/shared/publishRoot'

// planApproval.test.ts — B'-3d-3: 承認の要否判定・文面組み立てを main へ一元化するにあたり、
// **現行（旧 ChatPanel.tsx の approveToolCall クロージャ）の判定・文面と一字一句同じ結果**に
// なることを固定する（掟10: 止めるべき例・通すべき例を対で）。

describe('planApproval: write_file / edit_file', () => {
  it('通すべき例: auto モードでは write_file は素通り（承認不要）', () => {
    expect(planApproval('write_file', '{"path":"src/a.js","content":"x"}', { writeMode: 'auto' })).toBeNull()
  })

  it('通すべき例: auto モードでは edit_file も素通り', () => {
    expect(planApproval('edit_file', '{"path":"src/a.js"}', { writeMode: 'auto' })).toBeNull()
  })

  it('止めるべき例: confirm モードの write_file は承認が要り、label がパスそのもの', () => {
    const r = planApproval('write_file', '{"path":"src/a.js","content":"x"}', { writeMode: 'confirm' })
    expect(r).toEqual({ label: 'src/a.js' })
  })

  it('止めるべき例: confirm モードの edit_file は「（部分編集）」が付く', () => {
    const r = planApproval('edit_file', '{"path":"src/a.js"}', { writeMode: 'confirm' })
    expect(r).toEqual({ label: 'src/a.js（部分編集）' })
  })

  it('パスが読めない（壊れたJSON）ときは「(不明なファイル)」で確認を出す（黙って通さない）', () => {
    const r = planApproval('write_file', 'not json', { writeMode: 'confirm' })
    expect(r).toEqual({ label: '(不明なファイル)' })
  })

  it('path が空文字のときも「(不明なファイル)」', () => {
    const r = planApproval('write_file', '{"path":""}', { writeMode: 'confirm' })
    expect(r).toEqual({ label: '(不明なファイル)' })
  })
})

describe('planApproval: run_command', () => {
  it('通すべき例: auto モード＋無害なコマンドは素通り', () => {
    expect(planApproval('run_command', '{"command":"cat README.md"}', { writeMode: 'auto' })).toBeNull()
  })

  it('止めるべき例: auto モードでも危険なコマンドは常に承認が要る（理由つき）', () => {
    const r = planApproval('run_command', '{"command":"rm -rf ."}', { writeMode: 'auto', scopeDir: '/proj', scopeRoot: '/proj' })
    expect(r).toEqual({ label: 'コマンド実行: rm -rf .\n理由: この操作はファイルやシステムを壊す可能性があります。' })
  })

  it('止めるべき例: confirm モードでは無害なコマンドでも承認が要る（ただし理由は付かない）', () => {
    const r = planApproval('run_command', '{"command":"cat README.md"}', { writeMode: 'confirm', scopeDir: '/proj', scopeRoot: '/proj' })
    expect(r).toEqual({ label: 'コマンド実行: cat README.md' })
  })

  it('install 系: コマンドに名前が書いてあれば、そこから理由に載せる', () => {
    const r = planApproval('run_command', '{"command":"npm install express"}', { writeMode: 'auto', deps: [] })
    expect(r).toEqual({ label: 'コマンド実行: npm install express\n理由: インターネットからプログラム（express）を取得して実行します。' })
  })

  it('install 系: 名前の書かれていない npm install は、呼び出し側が渡した deps から理由に載る', () => {
    const r = planApproval('run_command', '{"command":"npm install"}', { writeMode: 'auto', deps: ['express', 'dotenv'] })
    expect(r).toEqual({
      label: 'コマンド実行: npm install\n理由: インターネットからプログラム（express、dotenv）を取得して実行します。',
    })
  })

  it('deps が未指定（undefined）でも、依存名なしの文面で確認を出す（クラッシュしない）', () => {
    const r = planApproval('run_command', '{"command":"npm install"}', { writeMode: 'auto' })
    expect(r).toEqual({ label: 'コマンド実行: npm install\n理由: インターネットからプログラムを取得して実行します。' })
  })

  it('いつもと違う場所（scopeDir ≠ scopeRoot）では、label に注意書きが付く', () => {
    const r = planApproval('run_command', '{"command":"ls"}', {
      writeMode: 'confirm', scopeDir: '/Users/x/projA', scopeRoot: '/Users/x/projB',
    })
    expect(r).toEqual({
      label: 'コマンド実行: ls\n⚠️ 通常と異なる場所で実行しようとしています。'
        + 'いま開いているのは「projA」ですが、「projB」の中で実行されます。心当たりがなければ拒否してください。',
    })
  })

  it('いつもどおりの場所（scopeRoot が scopeDir の中）では、注意書きが付かない', () => {
    const r = planApproval('run_command', '{"command":"ls"}', {
      writeMode: 'confirm', scopeDir: '/Users/x/proj', scopeRoot: '/Users/x/proj/public',
    })
    expect(r).toEqual({ label: 'コマンド実行: ls' })
  })

  it('作業フォルダの外へ出るコマンドは、止めずに一度だけ理由として見せる（2026-08-20 の決定）', () => {
    const r = planApproval('run_command', '{"command":"cd ../sibling && ls"}', { writeMode: 'auto' })
    expect(r).toEqual({ label: `コマンド実行: cd ../sibling && ls\n理由: 作業フォルダ（${PUBLISH_DIR_LABEL}）の外を操作しようとしています。` })
  })

  it('コマンドが読めない（壊れたJSON）ときも「(不明)」で確認を出す（黙って通さない）', () => {
    const r = planApproval('run_command', 'not json', { writeMode: 'confirm' })
    expect(r).toEqual({ label: 'コマンド実行: (不明)' })
  })

  it('壊れたJSON＋auto モードでは、危険と判定できないので素通り（cmd が空文字扱い）', () => {
    expect(planApproval('run_command', 'not json', { writeMode: 'auto' })).toBeNull()
  })
})

describe('planApproval: それ以外のツールは常に承認不要', () => {
  for (const name of ['read_file', 'list_files', 'fetch_url', 'search_web', 'search_docs', 'open_preview', 'search_in_files']) {
    it(`${name}: confirm モードでも null（write/edit/run 以外は判定対象外）`, () => {
      expect(planApproval(name, '{}', { writeMode: 'confirm' })).toBeNull()
    })
  }
})

describe('拒否時にAIへ返す文面（現行 ChatPanel.tsx と同一）', () => {
  it('write_file の拒否文面', () => {
    expect(writeDenialMessage('write_file', '{"path":"a.js"}')).toBe(
      'ユーザーが a.js の保存を許可しませんでした。保存せずに、どう進めるべきかユーザーに確認してください。',
    )
  })

  it('edit_file の拒否文面（「編集」になる）', () => {
    expect(writeDenialMessage('edit_file', '{"path":"a.js"}')).toBe(
      'ユーザーが a.js の編集を許可しませんでした。編集せずに、どう進めるべきかユーザーに確認してください。',
    )
  })

  it('パスが読めないときは「このファイル」', () => {
    expect(writeDenialMessage('write_file', 'not json')).toBe(
      'ユーザーが このファイル の保存を許可しませんでした。保存せずに、どう進めるべきかユーザーに確認してください。',
    )
  })

  it('run_command の拒否文面', () => {
    expect(runCommandDenialMessage('{"command":"rm -rf ."}')).toBe(
      'ユーザーがコマンド「rm -rf .」の実行を許可しませんでした。実行せずに、どう進めるべきかユーザーに確認してください。',
    )
  })

  it('コマンドが読めないときは空欄のまま文面を返す', () => {
    expect(runCommandDenialMessage('not json')).toBe(
      'ユーザーがコマンド「」の実行を許可しませんでした。実行せずに、どう進めるべきかユーザーに確認してください。',
    )
  })
})
