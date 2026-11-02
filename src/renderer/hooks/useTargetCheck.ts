// useTargetCheck.ts — ChatPanel が公開先の確認（targetCheck.ts）を使うための配線。
//
// ports（ファイルの読み取り・吹き出し・文脈の読み直し・送信）を、画面のいまの値に結びつけるだけの薄い層。
// 判断は targetCheck.ts にある。ここに「送る」口はあるが、呼ぶのは runTargetCheck
// （吹き出しのボタンを押したとき）だけで、公開先が変わった知らせでは呼ばない。

import { useCallback, useRef, useState } from 'react'
import { buildProjectContext } from '../aiContext'
import type { Op } from '../chatConvClient'
import { CHAT_APP_KEY, loadingKeys } from '../chatTurnRegistry'
import {
  runTargetCheck, spendsTargetCheckOffer, markTargetCheckSpent,
  type TargetCheckPorts, type TargetCheckSpent,
} from '../targetCheck'

/** 画面のいまの値。ports は呼ばれるたびにここから読むので、描画のあとに値が変わっても古い値を使わない。 */
export interface TargetCheckLive {
  projectDir: string | null | undefined
  apiKey: string | null | undefined
  claudeActive: boolean
  /** 応答中か */
  isBusy: boolean
  applyOp(op: Op): void
  /** プロジェクトの文脈（公開先の前提つき）を、送信が参照する置き場へ反映する */
  applyProjectCtx(v: { dir: string; ctx: string }): void
  send(text: string, images: string[]): unknown
}

/** 外の世界との出入り。既定は electronAPI と buildProjectContext。 */
export interface TargetCheckIo {
  readFile(path: string): Promise<string>
  latestChangeAt(dir: string): Promise<{ ok: boolean; latest: string | null }>
  buildContext(dir: string): Promise<string>
  /** いまの時刻。ボタンを押した時刻の記録に使う（省略すると new Date()） */
  now?(): Date
}

const realNow = (): Date => new Date()

const REAL_IO: TargetCheckIo = {
  readFile: (path) => window.electronAPI.fs.readFile(path),
  latestChangeAt: (dir) => window.electronAPI.fs.latestChangeAt(dir),
  buildContext: (dir) => buildProjectContext(dir),
  now: realNow,
}

/**
 * ほかのプロジェクトで AI が動いているか。押したプロジェクト自身と、単独チャット（プロジェクトを持たない）は数えない。
 * `keys` は実行中の鍵の一覧（既定はいまの登録簿）。
 */
export function isOtherProjectLoading(dir: string | null | undefined, keys: readonly string[] = loadingKeys()): boolean {
  return keys.some(k => k !== dir && k !== CHAT_APP_KEY && !k.startsWith(`${CHAT_APP_KEY}:`))
}

/** ports を作る。`live` は呼ぶたびに最新の値を返すこと。 */
export function makeTargetCheckPorts(live: () => TargetCheckLive, io: TargetCheckIo = REAL_IO): TargetCheckPorts {
  return {
    readFile: (path) => io.readFile(path),
    latestChangeAt: (dir) => io.latestChangeAt(dir),
    appendBubble: (msg) => live().applyOp({ kind: 'append', msg }),
    refreshProjectContext: async (dir) => {
      const ctx = await io.buildContext(dir)
      // 読んでいる間に別のプロジェクトへ切り替わっていたら、その文脈は置かない
      if (live().projectDir === dir) live().applyProjectCtx({ dir, ctx })
    },
    send: (text, images) => live().send(text, images),
    currentDir: () => live().projectDir,
    isBusy: () => live().isBusy,
    // 送り先が Claude のときだけ見る（AI Engine の応答はプロジェクトごとに独立していて、互いを止めない）
    otherProjectBusy: () => live().claudeActive && isOtherProjectLoading(live().projectDir),
    keys: () => ({ apiKey: live().apiKey, claudeActive: live().claudeActive }),
  }
}

// プロジェクトごとにボタンを押した時刻。パネルが作り直されても残す
// （チャットを閉じて開き直すたびに同じボタンが戻ると、同じ確認を何度も送れてしまうため）。
// 保存しないので、アプリを開き直すと消える。
let spentAt: TargetCheckSpent = new Map()

/** 押した時刻の記録をすべて消す（アプリを開き直した状態に戻す）。 */
export function resetTargetCheckSpent(): void {
  spentAt = new Map()
}

/**
 * 公開先の確認の配線。
 * - `ports`: 公開先が変わった知らせを受けて吹き出しを出すときに渡す（targetCheck.ts の `onTargetChanged`）。
 * - `spent`: プロジェクトごとにボタンを押した時刻。押す前の吹き出しのボタンを隠すのに使う。
 * - `press`: ボタンを押したときの処理。AI へ送るのはここだけ。
 */
export function useTargetCheck(live: TargetCheckLive, io?: TargetCheckIo) {
  const liveRef = useRef(live)
  liveRef.current = live
  const portsRef = useRef<TargetCheckPorts | null>(null)
  if (!portsRef.current) portsRef.current = makeTargetCheckPorts(() => liveRef.current, io)
  const ports = portsRef.current
  const [spent, setSpent] = useState<TargetCheckSpent>(() => spentAt)

  const now = io?.now ?? realNow

  const press = useCallback(async () => {
    // 押した時刻は押し始めに取る（確かめている間に出た新しい吹き出しのボタンを、隠さないため）
    const pressedAt = now()
    const dirAtPress = ports.currentDir()
    const result = await runTargetCheck(ports)
    const dir = result.sent ? result.dir : dirAtPress
    if (dir && spendsTargetCheckOffer(result)) {
      spentAt = markTargetCheckSpent(spentAt, dir, pressedAt)
      setSpent(spentAt)
    }
  }, [ports, now])

  return { ports, spent, press }
}
