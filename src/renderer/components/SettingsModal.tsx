import React, { useState, useEffect } from 'react'
import SakuraLogo from './SakuraLogo'
import {
  getSettings, setSettings, getUsage, getUsageByModel, resetThisMonth, budgetStatus, PRICING,
  modelLabel, getDefaultModel, setDefaultModel, priceFor,
  getUsageForKey, effectiveLimit, getKeyLimit,
  type BudgetSettings, type MonthUsage, type ModelUsageRow,
} from '../usage'
import { useModels } from '../hooks/useModels'
import { getAnthropicToken } from './CredentialsModal'
import { SHOW_THINKING_KEY, isThinkingAlwaysOpen } from './ThinkingBlock'
import { updateStatusText, shouldHighlight, type UpdateState } from '../../shared/updatePolicy'
import {
  isClaudeModeEnabled, setClaudeMode, claudeMonthKey,
  getClaudeCostThisMonth, approxJpyFromUsd, getClaudeWarnUsd, setClaudeWarnUsd, isOverClaudeWarnThreshold,
} from '../claudeMode'

interface KeyRow { label: string; apiKey: string }

interface Props {
  apiKey: string
  onClose: () => void
}

export default function SettingsModal({ apiKey, onClose }: Props) {
  const models = useModels(apiKey)
  const [settings, setLocal] = useState<BudgetSettings>(getSettings())
  const [usage, setUsage] = useState<MonthUsage>(getUsage())
  const [byModel, setByModel] = useState<ModelUsageRow[]>(getUsageByModel())
  const [ideModel, setIdeModel] = useState<string>(getDefaultModel('ide'))
  const [chatModel, setChatModel] = useState<string>(getDefaultModel('chat'))
  // 上限金額は空欄=無制限として扱う
  const [limitText, setLimitText] = useState<string>(
    settings.monthlyLimitYen == null ? '' : String(settings.monthlyLimitYen)
  )

  const [keys, setKeys] = useState<KeyRow[]>([])

  const refresh = () => { setUsage(getUsage()); setByModel(getUsageByModel()); setIdeModel(getDefaultModel('ide')); setChatModel(getDefaultModel('chat')); setLocal(getSettings()) }
  useEffect(() => {
    window.addEventListener('sakura-usage-changed', refresh)
    return () => window.removeEventListener('sakura-usage-changed', refresh)
  }, [])

  // 所見6: 「チャットの頭脳」セクション用。Claudeキーの有無は StatusBar.tsx の claudeActive 判定パターンを
  // 踏襲し、getAnthropicToken() を 'sakura:credentials-changed' 購読で再判定する。
  // アプリの更新。状態は main から流れてくる（購読は下の useEffect）。
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })
  const [applyError, setApplyError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    window.electronAPI.app.getVersion().then(setAppVersion).catch(() => { /* 版数が取れなくても支障はない */ })
    window.electronAPI.update.state().then(setUpdate).catch(() => { /* 未対応版でも画面は動く */ })
    return window.electronAPI.update.onState(s => { setUpdate(s); setApplyError(null) })
  }, [])

  const [claudeKey, setClaudeKey] = useState<string | null>(null)
  const [claudeModeOn, setClaudeModeOn] = useState<boolean>(isClaudeModeEnabled())
  // AIの思考を常に開いたままにするか（ThinkingBlock が同じキーを読む）
  const [thinkingAlwaysOpen, setThinkingAlwaysOpen] = useState<boolean>(isThinkingAlwaysOpen())
  useEffect(() => {
    let alive = true
    const refreshClaude = async () => {
      const key = await getAnthropicToken()
      if (alive) { setClaudeKey(key); setClaudeModeOn(isClaudeModeEnabled()) }
    }
    refreshClaude()
    window.addEventListener('sakura:credentials-changed', refreshClaude)
    return () => { alive = false; window.removeEventListener('sakura:credentials-changed', refreshClaude) }
  }, [])
  const hasClaudeKey = !!claudeKey
  const hasAiEngineKey = !!apiKey?.trim()

  // 所見8: 今月のClaude利用額（実額・USD）。モーダルは開閉のたびに再マウントされるため、初期値の取得のみで十分。
  const [claudeCostUsd] = useState<number>(getClaudeCostThisMonth())
  // 所見8（任意）: 警告のみのしきい値（USD）。送信のブロックはしない、表示のみの目安。
  const [warnUsdText, setWarnUsdText] = useState<string>(() => {
    const w = getClaudeWarnUsd()
    return w == null ? '' : String(w)
  })
  const onWarnUsdChange = (v: string) => {
    setWarnUsdText(v)
    if (v.trim() === '') { setClaudeWarnUsd(null); return }
    const n = Number(v)
    if (!Number.isNaN(n)) setClaudeWarnUsd(n)
  }

  // AIキー一覧を認証情報ストアから読み込む（キー別の利用状況表示用）
  useEffect(() => {
    ;(async () => {
      try {
        const enc = localStorage.getItem('sakura_credentials_enc')
        if (!enc) return
        const json = await window.electronAPI.secure.decrypt(enc)
        if (!json) return
        const store = JSON.parse(json)
        const entries = store?.aiEngine?.entries ?? []
        setKeys(entries
          .filter((e: any) => (e.values?.apiKey ?? '').trim())
          .map((e: any) => ({ label: e.label || '（無名）', apiKey: e.values.apiKey })))
      } catch { /* ignore */ }
    })()
  }, [])

  const persist = (next: BudgetSettings) => {
    setLocal(next)
    setSettings(next)
  }

  const onLimitChange = (v: string) => {
    setLimitText(v)
    const n = v.trim() === '' ? null : Math.max(0, Number(v))
    if (v.trim() === '' || !Number.isNaN(Number(v))) {
      persist({ ...settings, monthlyLimitYen: n })
    }
  }

  const status = budgetStatus()
  const ratioPct = status.ratio == null ? 0 : Math.min(100, status.ratio * 100)
  const barColor = status.over ? 'var(--red)' : status.warn ? 'var(--yellow)' : 'var(--sakura)'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-h-[90vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4">
          <SakuraLogo size={24} />
          <div>
            <h2 className="text-lg font-bold text-ink">設定</h2>
            <p className="text-xs text-ink-secondary">AI利用額の上限</p>
          </div>
          <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
        </div>

        <div className="px-6 pb-6 space-y-5">
          {/* Usage this month */}
          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs font-semibold text-ink-secondary">今月の利用状況（推定）</span>
              <span className="text-[11px] text-ink-muted">{usage.month}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-ink">¥{usage.costYen.toFixed(1)}</span>
              {status.limit != null && (
                <span className="text-sm text-ink-muted">/ ¥{status.limit}</span>
              )}
            </div>
            {/* progress */}
            {status.limit != null && (
              <div className="mt-2 h-2 rounded-full bg-overlay overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${ratioPct}%`, background: barColor }} />
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-muted">
              <span>{usage.totalTokens.toLocaleString()} トークン（≒文字数の目安。日本語1文字で1〜2トークン）（入力 {usage.promptTokens.toLocaleString()} / 出力 {usage.completionTokens.toLocaleString()}）</span>
              <button
                onClick={() => { resetThisMonth(); refresh() }}
                className="text-sakura hover:underline"
              >
                リセット
              </button>
            </div>
            {status.over && (
              <p className="mt-2 text-[11px] text-white bg-brand-red/90 rounded-md px-2 py-1">⚠️ 上限に達しています</p>
            )}
            {!status.over && status.warn && (
              <p className="mt-2 text-[11px] text-ink bg-brand-yellow/25 rounded-md px-2 py-1">上限の{Math.round(settings.warnRatio * 100)}%を超えました</p>
            )}

            {/* Per-key breakdown */}
            {keys.length > 0 && (
              <div className="mt-3 pt-3 border-t border-line">
                <div className="text-[11px] font-semibold text-ink-secondary mb-1.5">APIキー別の利用額／上限</div>
                <div className="space-y-1">
                  {keys.map((k, i) => {
                    const cost = getUsageForKey(k.apiKey).costYen
                    const lim = effectiveLimit(k.apiKey)
                    const explicit = getKeyLimit(k.apiKey)
                    const over = lim != null && cost >= lim
                    return (
                      <div key={i} className="flex items-center justify-between text-[11px]">
                        <span className="text-ink truncate mr-2">🔑 {k.label}</span>
                        <span className={`flex-none ${over ? 'text-brand-red font-medium' : 'text-ink-muted'}`}>
                          ¥{cost.toFixed(1)} / {lim == null ? '無制限' : `¥${lim}`}
                          <span className="text-ink-muted">{explicit === undefined ? '（既定）' : ''}</span>
                        </span>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[10px] text-ink-muted mt-1.5">上限はキーごとに「認証情報（⇧⌘,）」で設定できます。</p>
              </div>
            )}

            {/* Per-model breakdown */}
            {byModel.length > 0 && (
              <div className="mt-3 pt-3 border-t border-line">
                <div className="text-[11px] font-semibold text-ink-secondary mb-1.5">モデル別の利用額</div>
                <div className="space-y-1">
                  {byModel.map(row => (
                    <div key={row.model} className="flex items-center justify-between text-[11px]">
                      <span className="text-ink truncate mr-2">{modelLabel(row.model)}</span>
                      <span className="text-ink-muted flex-none">
                        {row.totalTokens.toLocaleString()} トークン ・ <span className="text-ink font-medium">¥{row.costYen.toFixed(1)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 所見8: 今月のClaude利用額（実額）。Claudeキー登録済みのときだけ表示する。 */}
          {hasClaudeKey && (
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-semibold text-ink-secondary">今月のClaude利用額（実額）</span>
                <span className="text-[11px] text-ink-muted">{claudeMonthKey()}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-ink">${claudeCostUsd.toFixed(4)}</span>
                <span className="text-sm text-ink-muted">（約¥{Math.round(approxJpyFromUsd(claudeCostUsd)).toLocaleString()}）</span>
              </div>
              <p className="mt-2 text-[11px] text-ink-muted">
                Claudeの利用料金はAnthropicに直接課金され、上の月間上限（¥）とは別枠です（概算換算・実際の請求はAnthropicのレート/通貨によります）。
              </p>

              {/* 所見8（任意）: 警告のみのしきい値。送信はブロックしない目安表示。 */}
              <div className="mt-3 pt-3 border-t border-line">
                <label className="text-[11px] font-semibold text-ink-secondary">警告の目安額（USD・任意）</label>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-ink-muted text-xs">$</span>
                  <input
                    value={warnUsdText}
                    onChange={e => onWarnUsdChange(e.target.value)}
                    inputMode="decimal"
                    placeholder="未設定"
                    className="flex-1 bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink placeholder-ink-muted outline-none focus:border-sakura transition-colors"
                  />
                </div>
                {isOverClaudeWarnThreshold(claudeCostUsd, getClaudeWarnUsd()) && (
                  <p className="mt-2 text-[11px] text-ink bg-brand-yellow/25 rounded-md px-2 py-1">⚠️ 設定した目安額を超えています</p>
                )}
              </div>
            </div>
          )}

          {/* アプリの更新（2026-08-10）。**勝手に再起動しない**のが設計の要。
              見つけたら裏でダウンロードだけ済ませ、切り替えは次回起動時。
              「いますぐ再起動」は利用者が押したときだけで、作業中なら断る（updatePolicy.ts）。 */}
          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-ink-secondary">アプリの更新</div>
              <button
                onClick={async () => { setUpdate(await window.electronAPI.update.check()) }}
                disabled={update.kind === 'checking' || update.kind === 'downloading'}
                className="text-[11px] border border-line rounded-md px-2 py-0.5 text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-50"
              >更新を確認</button>
            </div>
            <p className={`text-xs leading-relaxed select-text ${shouldHighlight(update) ? 'text-sakura font-medium' : 'text-ink-secondary'}`}>
              {updateStatusText(update) || `お使いの版: ${appVersion}`}
            </p>
            {shouldHighlight(update) && (
              <div className="mt-2 space-y-1">
                <button
                  onClick={async () => {
                    const r = await window.electronAPI.update.apply()
                    if (!r.ok) setApplyError(r.message)
                  }}
                  className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                >いますぐ再起動して更新する</button>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  押さなくても構いません。次に Koto を起動したときに自動で切り替わります。
                </p>
                {applyError && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {applyError}</p>}
              </div>
            )}
            {/* 更新の記録（2026-08-11）。更新は失敗しても画面が静かなままなので、
                「更新されない」と言われたときに原因を追える唯一の入口になる。
                非エンジニアに「~/Library/Logs を開いて」は通じないため、押すだけで場所が出る。 */}
            <button
              onClick={async () => {
                const r = await window.electronAPI.update.openLog()
                if (!r.ok) setApplyError(r.message ?? '記録を開けませんでした。')
              }}
              className="mt-2 text-[11px] text-ink-muted hover:text-sakura underline underline-offset-2"
            >更新の記録を表示…</button>
          </div>

          {/* AIの思考表示（2026-08-03 ユーザー要望）。推論モデルは本文が出るまで沈黙するため、
              待っている間の進行が見えるようにする。既定は「生成中だけ開き、終わったら畳む」。 */}
          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="text-xs font-semibold text-ink-secondary mb-2">AIの思考の表示</div>
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input
                type="checkbox"
                checked={thinkingAlwaysOpen}
                onChange={e => {
                  const on = e.target.checked
                  setThinkingAlwaysOpen(on)
                  if (on) localStorage.setItem(SHOW_THINKING_KEY, '1')
                  else localStorage.removeItem(SHOW_THINKING_KEY)
                }}
              />
              思考を常に開いたままにする
            </label>
            <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
              考えているモデル（Kimi K2.7 など）は、答えを書き始めるまでの考えを表示できます。
              既定では考えている間だけ開き、書き終わると自動で畳みます。オンにすると畳まずに残します。
              ※ 思考を出さないモデルでは表示されません。
              <strong className="font-medium text-ink-secondary">思考は英語で書かれることがあります</strong>
              （モデルが内部で使う言葉のため。回答そのものは日本語です）。
            </p>
          </div>

          {/* 所見6: チャットの頭脳（Claude / さくらのAI Engine）。両方のキーが登録済みのときだけ切替を出す。 */}
          {(hasClaudeKey || hasAiEngineKey) && (
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-xs font-semibold text-ink-secondary mb-2">チャットの頭脳</div>
              {hasClaudeKey && hasAiEngineKey ? (
                <>
                  <div className="flex bg-elevated border border-line rounded-xl p-1 gap-1">
                    <button
                      onClick={() => setClaudeMode(true)}
                      className={`flex-1 text-sm rounded-lg py-1.5 transition-colors ${claudeModeOn ? 'sakura-gradient text-white font-medium' : 'text-ink-secondary hover:text-ink'}`}
                    >
                      Claude
                    </button>
                    <button
                      onClick={() => setClaudeMode(false)}
                      className={`flex-1 text-sm rounded-lg py-1.5 transition-colors ${!claudeModeOn ? 'sakura-gradient text-white font-medium' : 'text-ink-secondary hover:text-ink'}`}
                    >
                      さくらのAI Engine
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-muted">切り替えると、次のメッセージから反映されます。</p>
                </>
              ) : hasClaudeKey ? (
                <p className="text-sm text-ink">Claudeで動作しています。</p>
              ) : (
                <p className="text-sm text-ink">さくらのAI Engineで動作しています（Claudeのキーを登録すると切り替えられます）。</p>
              )}
            </div>
          )}

          {/* Default model (IDE) */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">IDEで使うモデル（コード・公開向け）</label>
            <select
              value={ideModel}
              onChange={e => { setDefaultModel(e.target.value, 'ide'); setIdeModel(e.target.value) }}
              className="mt-1.5 w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-sakura cursor-pointer transition-colors"
            >
              {models.map(m => {
                const p = priceFor(m.id)
                return (
                  <option key={m.id} value={m.id}>
                    {m.label}（入力¥{p.in} / 出力¥{p.out} ・100万トークン）
                  </option>
                )
              })}
            </select>
            <p className="mt-1 text-[11px] text-ink-muted">
              コード作成・プロジェクト生成・公開前チェックで使います。
            </p>
          </div>

          {/* Default model (Chat) */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">チャットで使うモデル（相談・調査向け）</label>
            <select
              value={chatModel}
              onChange={e => { setDefaultModel(e.target.value, 'chat'); setChatModel(e.target.value) }}
              className="mt-1.5 w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-sakura cursor-pointer transition-colors"
            >
              {models.map(m => {
                const p = priceFor(m.id)
                return (
                  <option key={m.id} value={m.id}>
                    {m.label}（入力¥{p.in} / 出力¥{p.out} ・100万トークン）
                  </option>
                )
              })}
            </select>
            <p className="mt-1 text-[11px] text-ink-muted">
              チャットモードの会話で使います。会話ごとに個別変更もできます。
            </p>
          </div>

          {/* Default limit setting */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">既定の月間上限（円）</label>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-ink-muted">¥</span>
              <input
                value={limitText}
                onChange={e => onLimitChange(e.target.value)}
                inputMode="numeric"
                placeholder="無制限"
                className="flex-1 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura transition-colors"
              />
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              キーごとに上限を設定していない場合に適用される既定値です（空欄で無制限）。キー個別の上限は「認証情報（⇧⌘,）」で設定します。
            </p>
          </div>

          {/* Enforce toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-xs font-semibold text-ink">上限に達したらリクエストを停止</div>
              <div className="text-[11px] text-ink-muted">オフの場合は警告のみ表示します</div>
            </div>
            <button
              onClick={() => persist({ ...settings, enforce: !settings.enforce })}
              className={`w-11 h-6 rounded-full transition-colors flex items-center px-0.5 ${settings.enforce ? 'sakura-gradient' : 'bg-overlay'}`}
            >
              <span className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.enforce ? 'translate-x-5' : ''}`} />
            </button>
          </label>

          {/* Pricing note */}
          <details className="text-[11px] text-ink-muted">
            <summary className="cursor-pointer hover:text-ink-secondary">単価について</summary>
            <div className="mt-2 space-y-1">
              <p>内蔵の概算単価（¥/100万トークン）で利用額を推定しています：</p>
              <ul className="space-y-0.5">
                {/* 所見29: 内部モデルID（Qwen3-Coder-480B…）の生表示を避け、表示名に揃える。 */}
                {Object.entries(PRICING).map(([m, p]) => (
                  <li key={m}>・{modelLabel(m)}: 入力 ¥{p.in} / 出力 ¥{p.out}</li>
                ))}
              </ul>
              <p className="pt-1">
                実際の課金・無料枠は{' '}
                <a href="https://www.sakura.ad.jp/aipf/ai-engine/" className="text-sakura hover:underline">さくらのAI Engine 公式</a>
                {' '}をご確認ください。これはあくまでアプリ側の使いすぎ防止の目安です。
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
