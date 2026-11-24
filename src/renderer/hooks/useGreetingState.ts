// useGreetingState.ts — あいさつ（greeting.ts の runGreeting）の「考えています…」と ⏹ 停止の状態を、
// プロジェクトの印つきで持つ（ChatPanel から切り出した節）。
//
// 掟11（環境の独立）: あいさつの応答中に別のプロジェクトへ切り替えても、切り替えた先に A の「考えています…」や
// ⏹ 停止が出ない・B の ⏹ で A のあいさつが止まらない。A に戻ったときは、まだ続いていれば今までどおり出る。
// 印の判断は純関数（下の3つ）に置き、テストで固定する。

import { useState, useRef, useCallback, useEffect } from 'react'

/** あいさつの生成中のプロジェクトの集まり（同時に複数あり得るので、1つの真偽値にしない）。 */
export type GreetLoadingDirs = ReadonlySet<string>

/** dir のあいさつの生成中の印を付ける／外す。 */
export function withGreetLoading(dirs: GreetLoadingDirs, dir: string, loading: boolean): GreetLoadingDirs {
  if (dirs.has(dir) === loading) return dirs
  const next = new Set(dirs)
  if (loading) next.add(dir)
  else next.delete(dir)
  return next
}

/** いま開いているプロジェクトに「考えています…」と ⏹ 停止を出すか。印が開いているプロジェクトのときだけ出す。 */
export function isGreetLoadingFor(dirs: GreetLoadingDirs, viewingDir: string | null | undefined): boolean {
  return !!viewingDir && dirs.has(viewingDir)
}

/** 中断関数の登録先。始めたプロジェクトの印つき。 */
export type GreetAborts = Map<string, () => void>

/** 登録されている中断関数をすべて呼ぶ（呼んだ数を返す）。画面から外れるとき（アンマウント）の後片付け用。 */
export function abortAllGreetings(aborts: GreetAborts): number {
  const all = [...aborts.values()]
  for (const abort of all) abort()
  return all.length
}

/** ⏹ 停止で止めるのは、いま開いているプロジェクトのあいさつだけ。止めたら true。 */
export function abortGreetingOf(aborts: GreetAborts, viewingDir: string | null | undefined): boolean {
  if (!viewingDir) return false
  const abort = aborts.get(viewingDir)
  if (!abort) return false
  abort()
  return true
}

export function useGreetingState(viewingDir: string | null | undefined) {
  const [dirs, setDirs] = useState<GreetLoadingDirs>(new Set())
  const abortsRef = useRef<GreetAborts>(new Map())
  /** dir のあいさつの生成中の印を付ける／外す。 */
  const setLoadingOf = useCallback((dir: string, loading: boolean) => {
    setDirs(prev => withGreetLoading(prev, dir, loading))
  }, [])
  /** dir のあいさつの中断関数を登録する（null で外す）。 */
  const setAbortOf = useCallback((dir: string, abort: (() => void) | null) => {
    if (abort) abortsRef.current.set(dir, abort)
    else abortsRef.current.delete(dir)
  }, [])
  // チャット欄が外れる（閉じる・チャットモードへ移る）と、印も中断関数も ChatPanel と一緒に消えるのに、
  // runGreeting は走り続け、付け直した画面には「考えています…」も ⏹ も出ず、利用者の回とあいさつが同じ会話を
  // 書き合いうる。外れるときに、登録されている中断関数をすべて呼んで止める。
  useEffect(() => () => { abortAllGreetings(abortsRef.current) }, [])
  const abortViewing = useCallback(() => abortGreetingOf(abortsRef.current, viewingDir), [viewingDir])
  return { greetLoading: isGreetLoadingFor(dirs, viewingDir), setLoadingOf, setAbortOf, abortViewing }
}
