// isolatedProject.ts — 破棄のテストで、プロジェクトのフォルダを「自分だけの親フォルダ」の中に作る。
//
// ── なぜ要るか（2026-10-21）──────────────────────────────────────────────────────
// 保存場所の破棄は、バケットごと消す前に**同じ親フォルダの兄弟プロジェクトの記録**を読む（main/cloud/bucketUsers.ts）。
// 一時フォルダ（os.tmpdir()）の直下にプロジェクトを作ると、同時に走る別の試験の残り物・読めないフォルダを兄弟として読み、
// 「ほかのプロジェクトも使っている」「わからない」と判断してバケットを消さず、結果が試験の実行順や環境で変わる。
// バケットごと消えることを確かめる試験は、これで作ったフォルダを使う（親フォルダごとの片づけはファイルの最後）。
import { afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspaces: string[] = []

/** 使い捨ての親フォルダの中に、`prefix` で始まる名前のプロジェクトのフォルダを1つ作って返す。 */
export function isolatedProjectDir(prefix: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-ws-'))
  workspaces.push(ws)
  return fs.mkdtempSync(path.join(ws, prefix))
}

/** 親フォルダ（兄弟のプロジェクトを置く場所）。 */
export const workspaceDirOf = (projectDir: string): string => path.dirname(projectDir)

afterAll(() => { for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true }) })
