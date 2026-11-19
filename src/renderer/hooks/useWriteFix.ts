// useWriteFix.ts — ChatPanel が「🛠 AIに修正させる」（writeFix.ts）を使うための配線。
//
// ports（ファイルの読み取り・吹き出し・送信）を、画面のいまの値に結びつけるだけの薄い層。
// 判断は writeFix.ts にある。AI へ送るのは、吹き出しのボタンを押したとき（press）だけ。

import { useCallback, useRef } from 'react'
import type { Op } from '../chatConvClient'
import type { WriteFixMark } from '../../shared/securityFindings'
import { runWriteFix, createPressGate, type PressGate, type RunWriteFixResult, type WriteFixPorts } from '../writeFix'
import { isOtherProjectLoading } from './useTargetCheck'

/** 画面のいまの値。ports は呼ばれるたびにここから読むので、描画のあとに値が変わっても古い値を使わない。 */
export interface WriteFixLive {
  projectDir: string | null | undefined
  apiKey: string | null | undefined
  claudeActive: boolean
  /** AI の作業フォルダ（`public/`。無ければプロジェクト直下）の絶対パス */
  aiRoot: string | null | undefined
  /** 応答中か */
  isBusy: boolean
  applyOp(op: Op): void
  send(text: string, images: string[]): unknown
}

/** 外の世界との出入り。既定は electronAPI。 */
export interface WriteFixIo {
  read: WriteFixPorts['read']
}

const REAL_IO: WriteFixIo = {
  read: (dir, file) => window.electronAPI.fs.readForWriteFix(dir, file),
}

/** ports を作る。`live` は呼ぶたびに最新の値を返すこと。 */
export function makeWriteFixPorts(live: () => WriteFixLive, io: WriteFixIo = REAL_IO): WriteFixPorts {
  return {
    read: (dir, file) => io.read(dir, file),
    appendBubble: (msg) => live().applyOp({ kind: 'append', msg }),
    send: (text, images) => live().send(text, images),
    currentDir: () => live().projectDir,
    isBusy: () => live().isBusy,
    // 送り先が Claude のときだけ見る（AI Engine の応答はプロジェクトごとに独立していて、互いを止めない）
    otherProjectBusy: () => live().claudeActive && isOtherProjectLoading(live().projectDir),
    keys: () => ({ apiKey: live().apiKey, claudeActive: live().claudeActive }),
    aiRoot: () => live().aiRoot,
  }
}

/** 「AIに修正させる」の配線。`press` は、その吹き出しの印を渡して呼ぶ。AI へ送るのはここだけ。 */
export function useWriteFix(live: WriteFixLive, io?: WriteFixIo) {
  const liveRef = useRef(live)
  liveRef.current = live
  const portsRef = useRef<WriteFixPorts | null>(null)
  if (!portsRef.current) portsRef.current = makeWriteFixPorts(() => liveRef.current, io)
  const ports = portsRef.current

  // 送った直後の押し直しを止める（送る側は鍵の読み出しなどを待つので、その間は isBusy が偽のまま）
  const gateRef = useRef<PressGate | null>(null)
  if (!gateRef.current) gateRef.current = createPressGate()
  const gate = gateRef.current
  const press = useCallback(async (marks: readonly WriteFixMark[] | undefined): Promise<RunWriteFixResult> => {
    if (!gate.allow(ports.isBusy())) return { sent: false, reason: 'busy' }
    const r = await runWriteFix(ports, marks)
    if (r.sent) gate.markSent()
    return r
  }, [ports, gate])

  return { ports, press }
}
