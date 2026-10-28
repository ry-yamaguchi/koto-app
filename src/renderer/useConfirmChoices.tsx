// useConfirmChoices.tsx — 選択（チェック）つきの確認を出すフック（段階2・2b-1。設計書 docs/teardown-unify-plan.md の 10.7.7 (1)）。
//
// useConfirm.tsx は 1文字も変えない（14か所が使っており、tests/confirmModalWiring.test.ts が戻り値の形を固定している）。
// このフックは、選択の無い確認（confirm）と選択つきの確認（confirmWithChoices）の**両方**を、1つの ConfirmModal で出す。
// 破棄の流れ（teardown/useTeardownFlow.ts）は useConfirm の代わりにこれを使い、共用型の「コンテナレジストリも削除する」を聞く。
//
// ── 歯止め（掟10）────────────────────────────────────────────────────────────
// 「どのボタンが押されたか・チェックがどうなっているか → 答え」の判断は resolveConfirmWithChoices（純関数）に切り出し、
// tests/confirmChoices.test.ts が固定する（このプロジェクトの vitest は DOM を持たず、押す操作を試せないため。useConfirm の resolveConfirm と同じ作り）。
//   ・キャンセル（cancel）は { confirmed: false, choices: {} }。押さなくても true にならない
//   ・値が無い（undefined＝触っていない）ときだけ defaultChecked。boolean ならそのまま。**ほかの値（'yes'・1・null など）は false**
//     （不明な値を defaultChecked に倒すと、Koto が作ったレジストリ〔defaultChecked が true〕を「消す」にしてしまう）
// 使う React の機能は useState・useCallback だけ（tests/teardownCommonWiring.test.ts の決まり）。

import { useCallback, useState } from 'react'
import ConfirmModal, { type ConfirmChoice } from './components/ConfirmModal'
import { resolveConfirm, type ConfirmOptions } from './useConfirm'

export type { ConfirmChoice }
export type ConfirmWithChoicesOptions = ConfirmOptions & { choices: ConfirmChoice[] }
export type ConfirmWithChoicesAnswer = { confirmed: boolean; choices: Record<string, boolean> }

/** 1つの選択の、いまの値。値が無い（触っていない）ときだけ既定。boolean 以外の値は false（不明な値を「入れる」に倒さない）。 */
export function choiceValueOf(choice: Pick<ConfirmChoice, 'id' | 'defaultChecked'>, values: Record<string, unknown>): boolean {
  const v = Object.prototype.hasOwnProperty.call(values, choice.id) ? values[choice.id] : undefined
  return v === undefined ? choice.defaultChecked === true : v === true
}

/**
 * 押したボタンとチェックの状態から答えを作る（純関数・DOM/React に依存しない）。
 * 流れ（teardown/flow.ts）は、更にこの値を `=== true` のものだけ true にして invoke へ渡す（同じ規則の二重の守り）。
 */
export function resolveConfirmWithChoices(
  choice: 'confirm' | 'cancel',
  choices: ConfirmChoice[],
  values: Record<string, unknown>,
): ConfirmWithChoicesAnswer {
  if (choice !== 'confirm') return { confirmed: false, choices: {} }
  const out: Record<string, boolean> = {}
  for (const c of choices) out[c.id] = choiceValueOf(c, values)
  return { confirmed: true, choices: out }
}

type Pending = {
  opts: ConfirmOptions
  choices: ConfirmChoice[]
  values: Record<string, boolean>
  /** どのボタンで閉じたか → 呼び出し元の Promise を解決する。 */
  done: (choice: 'confirm' | 'cancel', values: Record<string, unknown>) => void
}

/** 1つの ConfirmModal で、選択の無い確認（confirm）と選択つきの確認（confirmWithChoices）の両方を出す。 */
export function useConfirmChoices() {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      setPending({ opts, choices: [], values: {}, done: choice => resolve(resolveConfirm(choice)) })
    })
  }, [])

  const confirmWithChoices = useCallback((opts: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
    return new Promise<ConfirmWithChoicesAnswer>(resolve => {
      const { choices, ...rest } = opts
      setPending({ opts: rest, choices, values: {}, done: (choice, values) => resolve(resolveConfirmWithChoices(choice, choices, values)) })
    })
  }, [])

  const answer = useCallback((choice: 'confirm' | 'cancel') => {
    setPending(current => {
      if (current) current.done(choice, current.values)
      return null
    })
  }, [])

  const toggle = useCallback((id: string, checked: boolean) => {
    setPending(current => (current ? { ...current, values: { ...current.values, [id]: checked } } : current))
  }, [])

  const element = (
    <ConfirmModal
      open={pending !== null}
      title={pending?.opts.title ?? ''}
      body={pending?.opts.body ?? ''}
      confirmLabel={pending?.opts.confirmLabel}
      cancelLabel={pending?.opts.cancelLabel}
      danger={pending?.opts.danger}
      choices={pending?.choices}
      choiceValues={pending ? Object.fromEntries(pending.choices.map(c => [c.id, choiceValueOf(c, pending.values)])) : undefined}
      onToggleChoice={toggle}
      onConfirm={() => answer('confirm')}
      onCancel={() => answer('cancel')}
    />
  )

  return { confirm, confirmWithChoices, element }
}
