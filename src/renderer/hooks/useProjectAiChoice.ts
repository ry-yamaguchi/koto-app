// useProjectAiChoice.ts — チャット欄の「使う AI とモデル」を、プロジェクトの記憶 → 設定の既定の順で決めるフック。
// ChatPanel から切り出した節の受け皿（Claude のキーの読み込み・モデル一覧・提供終了の追従）。
// 決めるのは projectAi.ts の currentAiChoice だけ。値は描画の中で同期に求める（state と effect で写さない）。
// 記憶に書くのは上の選択（selectModel）と、新しい案内のボタン（switchToClaudeHere）だけ。設定の既定は書かない。

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { useModelList, refetchSakuraModelIds } from './useModels'
import { useClaudeModelList, refetchClaudeModelIds } from './useClaudeModels'
import { getAnthropicToken } from '../components/CredentialsModal'
import { modelLabel, retiredModelNoticeText, syncStoredDefaultWithOffered } from '../usage'
import { claudeModelShortLabel, syncStoredClaudeDefaultWithOffered } from '../claudeMode'
import {
  currentAiChoice, forgetProjectModel, readProjectAi, rememberProjectBrain, rememberProjectModel,
  type AiBrain, type AiChoice, type ProjectAiMemory,
} from '../projectAi'
import { subscribeAiChoice, getAiChoiceVersion } from '../aiChoiceSignal'
import { subscribe as subscribeTurns, getSnapshot as getTurnsSnapshot, getTurn, turnKey } from '../chatTurnRegistry'
import type { Op } from '../chatConvClient'

// 案内を出した印（プロジェクト・AI・提供終了したモデル）。チャット欄を作り直しても覚えておく。
const noticed = new Set<string>()
// 案内の待ち行列。回が走っている間は出さず、回が終わった描画で出す。
const pending = new Map<string, { dir: string; brain: AiBrain; text: string }>()

export function useProjectAiChoice({ projectDir, apiKey, convLoadedDir, applyOp }: {
  projectDir: string | null
  apiKey: string
  convLoadedDir: string | null
  applyOp: (op: Op) => void
}) {
  const { models, live: modelsLive } = useModelList(apiKey)
  // Claude のキー（使う瞬間に読む。方式B）。
  const [claudeKey, setClaudeKey] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const key = await getAnthropicToken()
      if (!alive) return
      setClaudeKey(key ?? '')
    }
    refresh()
    window.addEventListener('sakura:credentials-changed', refresh)
    return () => { alive = false; window.removeEventListener('sakura:credentials-changed', refresh) }
  }, [])
  const { models: claudeModels, live: claudeLive } = useClaudeModelList(claudeKey)

  // 記憶・既定が変わったら描き直す（値は使わない）。
  useSyncExternalStore(subscribeAiChoice, getAiChoiceVersion, getAiChoiceVersion)
  // 回の走っている・いないが変わったら描き直す（提供終了の案内を回の途中に出さないため）。
  useSyncExternalStore(subscribeTurns, getTurnsSnapshot)
  const turnRunning = projectDir ? getTurn(turnKey(projectDir)).isLoading : false

  // プロジェクトを開いていないときだけ使う、画面の中だけの選び（保存しない）。
  const [looseChoice, setLooseChoice] = useState<ProjectAiMemory>({})

  const choice: AiChoice = currentAiChoice(
    projectDir,
    { hasClaudeKey: !!claudeKey, hasEngineKey: !!apiKey },
    { sakuraModelIds: models.map(m => m.id), claudeModelIds: claudeModels.map(m => m.id), override: looseChoice },
  )

  // 保存済みの既定が提供終了なら（一覧が実際に取得できたときだけ）保存し直す。
  useEffect(() => {
    if (!models.length) return
    syncStoredDefaultWithOffered('ide', models.map(m => m.id), modelsLive)
  }, [models, modelsLive])
  useEffect(() => {
    if (!claudeModels.length) return
    syncStoredClaudeDefaultWithOffered(claudeModels.map(m => m.id), claudeLive)
  }, [claudeModels, claudeLive])

  // 最新の値を、非同期の続きから読むための置き場。
  const latest = useRef({ projectDir, convLoadedDir, choice, turnRunning, applyOp, models, claudeModels, apiKey, claudeKey })
  latest.current = { projectDir, convLoadedDir, choice, turnRunning, applyOp, models, claudeModels, apiKey, claudeKey }

  // 待っている案内を、出してよければ出す（見ているプロジェクトの読み込み済みの会話に・回が走っていないとき・使っている AI の側だけ）。
  const flushNotices = useCallback(() => {
    const cur = latest.current
    if (!cur.projectDir || cur.convLoadedDir !== cur.projectDir || cur.turnRunning) return
    for (const [k, n] of [...pending]) {
      if (n.dir !== cur.projectDir || n.brain !== cur.choice.brain) continue
      pending.delete(k)
      cur.applyOp({ kind: 'append', msg: { role: 'assistant', content: n.text } })
    }
  }, [])

  // 提供終了のモデルを覚えていたら、まず一覧を取り直し、取り直した一覧（live）にも無いときだけ、
  // 記憶の項目を消して案内を待ち行列へ入れる。一覧が live でない AI は判断しない。
  const retiredKey = JSON.stringify(choice.retired)
  useEffect(() => {
    if (!projectDir || convLoadedDir !== projectDir) return
    const targets = choice.retired.filter(r => (r.brain === 'claude' ? claudeLive : modelsLive))
    if (targets.length === 0) { flushNotices(); return }
    let cancelled = false
    void (async () => {
      const wantSakura = targets.some(r => r.brain === 'sakura') && !!apiKey
      const wantClaude = targets.some(r => r.brain === 'claude') && !!claudeKey
      const sakuraIds = wantSakura ? await refetchSakuraModelIds(apiKey) : null
      const claudeIds = wantClaude ? await refetchClaudeModelIds(claudeKey) : null
      if (cancelled) return
      const cur = latest.current
      for (const r of targets) {
        // 取り直しで確かめられた AI の側だけを判断する（取れなかった側は、記憶を消さず案内も出さない）。
        const ids = r.brain === 'claude' ? claudeIds : sakuraIds
        if (!ids) continue
        // 取り直した一覧にあった（古い一覧で提供終了と誤った）なら、何もしない。
        if (ids.includes(r.from)) continue
        // 記憶の項目が、まだ提供終了のそのモデルのままのときだけ消す（その間に選び直されていたら残す）。
        if (r.fromProject && readProjectAi(projectDir)[r.brain === 'claude' ? 'claudeModel' : 'sakuraModel'] === r.from) {
          forgetProjectModel(projectDir, r.brain)
        }
        const k = `${projectDir}\n${r.brain}\n${r.from}`
        if (noticed.has(k)) continue
        noticed.add(k)
        const label = r.brain === 'claude' ? claudeModelShortLabel(r.to, cur.claudeModels) : modelLabel(r.to)
        pending.set(k, { dir: projectDir, brain: r.brain, text: retiredModelNoticeText(r.from, label) })
      }
      flushNotices()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, convLoadedDir, retiredKey, modelsLive, claudeLive, !!apiKey, !!claudeKey])

  // 回が終わった描画で、待っていた案内を出す。
  useEffect(() => { flushNotices() }, [turnRunning, convLoadedDir, projectDir, choice.brain, flushNotices])

  const selectModel = (id: string) => {
    const side: AiBrain = choice.brain === 'claude' ? 'claude' : 'sakura'
    if (projectDir) rememberProjectModel(projectDir, side, id)
    else setLooseChoice(prev => ({ ...prev, [side === 'claude' ? 'claudeModel' : 'sakuraModel']: id }))
  }

  // さくらのキーが無くて使えないプロジェクトで、Claude のキーがあるとき、利用者が押したときだけ Claude にする。
  const switchToClaudeHere: (() => void) | null =
    projectDir && choice.brain === null && choice.missingKey === 'sakura' && !!claudeKey
      ? () => rememberProjectBrain(projectDir, 'claude')
      : null

  return {
    models, modelsLive, claudeKey, claudeModels, claudeLive, choice,
    claudeActive: choice.brain === 'claude',
    model: choice.sakuraModel,
    claudeModelId: choice.claudeModel,
    selectModel,
    switchToClaudeHere,
  }
}
