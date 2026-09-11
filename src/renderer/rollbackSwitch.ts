// rollbackSwitch.ts — RollbackSection.tsx の「バージョンを切り替える」判断・実行を、
// React/DOM から切り離した純関数として持つ（掟10と同じ考え方: 守りは1箇所に集め、テストで固定する）。
//
// 2026-09-08 検分で指摘: 確認ダイアログ（当時は window.confirm）を通ったときだけ実行する、という
// 歯止めが**文字列一致でしか守られていなかった**（呼び出しの条件に `false &&` を挟むだけで
// 通ってしまうような変異が、既存のテストをすべて素通りした）。ここでは confirm・rollback を「注入」で
// 受け取る形にし、**偽の confirm/rollback を渡した振る舞いテスト**（tests/rollbackSwitch.test.ts）で
// 「confirm が false を返したら rollback は一度も呼ばれない」ことを固定する。
// （main 側の対の歯止めは src/main/cloud/rollback.ts の performRollback。）

export interface SwitchRequest {
  /** 切り替え先のバージョン名。`null` なら「最新に追従」へ戻す。 */
  versionName: string | null
  /** 確認文言に出す表示名。 */
  label: string
  /** いまの配分が split（複数バージョンへ分散・または判断できない）かどうか。 */
  isSplit: boolean
}

export type ConfirmFn = (message: string) => boolean
export type RollbackFn = (
  versionName: string | null,
  opts: { confirmed: boolean },
) => Promise<{ ok: boolean; message?: string }>

export interface SwitchDeps {
  confirm: ConfirmFn
  rollback: RollbackFn
}

export type SwitchOutcome =
  | { proceeded: false }
  | { proceeded: true; result: { ok: boolean; message?: string } }

/**
 * 確認ダイアログに出す文言。split のときは「いまの配分は失われる」ことに触れる
 * （3【中】: 画面は split で「この機能では変更しません」と書きながら、行の
 * 「このバージョンに戻す」は押せて、押すと配分が単独100%へ潰れるのに確認文が
 * その事実に触れていなかった。触れる側に寄せ、確認文に含める）。
 */
export function buildSwitchConfirmMessage(req: SwitchRequest): string {
  const splitNote = req.isSplit ? 'いまの配分（複数バージョンへの分散）は失われます。' : ''
  return req.versionName === null
    ? `最新のバージョンに自動で追従する状態へ戻します。${splitNote}訪問者に見えるものが変わることがあります。よろしいですか？`
    : `訪問者に見えるものが『${req.label}』に切り替わります。${splitNote}よろしいですか？`
}

/**
 * confirm を通ったときだけ rollback を呼ぶ。confirm が false（キャンセル）なら
 * rollback には一切触れない。
 */
export async function runSwitch(req: SwitchRequest, deps: SwitchDeps): Promise<SwitchOutcome> {
  const confirmed = deps.confirm(buildSwitchConfirmMessage(req))
  if (!confirmed) return { proceeded: false }
  const result = await deps.rollback(req.versionName, { confirmed: true })
  return { proceeded: true, result }
}
