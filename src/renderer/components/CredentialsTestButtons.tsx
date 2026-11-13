import React, { useState } from 'react'
import { cleanRemoteError } from '../remoteError'
import ErrorBand from './ErrorBand'
import FailureLines from './FailureLines'
import { testedKey } from '../credentialsSaved'

// 認証情報の窓の「🔌 接続テスト」ボタン5つ（さくらのAI Engine・GitHub・Claude・HANAMII・Vercel）。CredentialsModal.tsx から切り出した。
// さくらのクラウド・専有型の疎通確認は、この窓ではなく各公開パネル（AppRunPanel・AppRunDedicatedPanel）にある。
//
// 接続テストが通っても、入力した値はまだ保存されていない（「保存」を押すまで使えない）ことがある。
// その一言は UnsavedTestNote の1つだけが持つ。各ボタンは「通ったとき」に置くだけで、文を複製しない（掟10）。

export const UNSAVED_TEST_NOTE = 'まだ保存していません。下の「保存」を押すと使えます。'

/** 接続テストが通ったとき、結果の隣に出す一言。**テストにかけた値**が保存されている値と違うときだけ。
 *  窓全体の未保存ではなく、そのカード（項目）の値で決める。保存すると保存済みの値が更新され、消える。 */
export function UnsavedTestNote({ tested, saved }: { tested: string | null; saved: string | null }) {
  if (tested === null || tested === saved) return null
  return <span className="text-[11px] text-brand-yellow">{UNSAVED_TEST_NOTE}</span>
}

export function KeyTestButton({ apiKey, saved }: { apiKey: string; saved: string | null }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  // テストにかけた値（メモリの中だけ）。保存済みの値と比べて一言を出すかを決める。
  const [tested, setTested] = useState<string | null>(null)
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('キーが空です'); return }
    setState('testing'); setTested(testedKey(apiKey))
    try {
      const models = await window.electronAPI.sakura.models(apiKey.trim())
      setState('ok'); setDetail(`利用可能なモデル: ${models.length}個`)
    } catch (e: any) {
      setState('ng'); setDetail(cleanRemoteError(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}
      {state === 'ng' && <ErrorBand tone="text" text={`❌ ${detail}`} />}
    </div>
  )
}

// GitHub のトークン疎通テスト（GET /user）。接続OK時はログイン名を表示する。
export function GithubTestButton({ apiKey, saved }: { apiKey: string; saved: string | null }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  // テストにかけた値（メモリの中だけ）。保存済みの値と比べて一言を出すかを決める。
  const [tested, setTested] = useState<string | null>(null)
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing'); setTested(testedKey(apiKey))
    try {
      const r = await window.electronAPI.github.test(apiKey.trim())
      if (r.ok) { setState('ok'); setDetail(r.login ? `ログイン: ${r.login}` : '接続できました') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(cleanRemoteError(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}
      {state === 'ng' && <ErrorBand tone="text" text={`❌ ${detail}`} />}
    </div>
  )
}

// Claude（Anthropic API）のキー疎通テスト（GET /v1/models）。接続OK時は利用可能なモデル件数を表示する。
export function AnthropicTestButton({ apiKey, saved }: { apiKey: string; saved: string | null }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  // テストにかけた値（メモリの中だけ）。保存済みの値と比べて一言を出すかを決める。
  const [tested, setTested] = useState<string | null>(null)
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('キーが空です'); return }
    setState('testing'); setTested(testedKey(apiKey))
    try {
      const r = await window.electronAPI.claude.test(apiKey.trim())
      if (r.ok) { setState('ok'); setDetail(`利用可能なモデル: ${r.modelCount ?? 0}個`) }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(cleanRemoteError(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ <FailureLines text={detail} /></span>}
    </div>
  )
}

// HANAMII トークンの接続テスト（ワークスペース一覧の取得で有効性を確認・読み取りのみ）。
export function HanamiiTestButton({ token, saved }: { token: string; saved: string | null }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  // テストにかけた値（メモリの中だけ）。保存済みの値と比べて一言を出すかを決める。
  const [tested, setTested] = useState<string | null>(null)
  const test = async () => {
    if (!token.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing'); setTested(testedKey(token))
    try {
      const r = await window.electronAPI.hanamii.testConnection(token.trim())
      if (r.ok) { setState('ok'); setDetail('') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(cleanRemoteError(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK</span>}
      {state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ <FailureLines text={detail} /></span>}
    </div>
  )
}

// Vercel トークンの接続テスト（読み取りのみ）。teamId は任意。
// **2段階**で見る: (1)トークンが有効か（/v2/user）(2)公開する範囲が見えているか（デプロイ一覧）。
// (2)が通らないときは緑の ✅ にしない（2026-08-22 Ryosuke 指摘。範囲の無いトークンでも
// (1)は 200 を返すため、「接続OK」と出したのに公開で落ちる形になっていた）。
export function VercelTestButton({ token, teamId, saved }: { token: string; teamId: string; saved: string | null }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'warn' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  // テストにかけた値（メモリの中だけ）。保存済みの値と比べて一言を出すかを決める。
  const [tested, setTested] = useState<string | null>(null)
  const test = async () => {
    if (!token.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing'); setTested(testedKey(token, teamId))
    try {
      const r = await window.electronAPI.vercel.testConnection(token.trim(), teamId.trim() || undefined)
      if (r.ok) { setState(r.warn ? 'warn' : 'ok'); setDetail(r.message ?? '') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(cleanRemoteError(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ {detail || '接続OK'}</span>}
      {state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}
      {state === 'warn' && <span className="text-[11px] text-brand-yellow whitespace-pre-wrap select-text">⚠️ <FailureLines text={detail} /></span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ <FailureLines text={detail} /></span>}
    </div>
  )
}

