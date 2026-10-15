import { useId } from 'react'
import {
  ACCOUNT_MISMATCH_NOTE,
  formatProjectNames,
  singlePrefillNote,
  type ServicePrincipalCandidate,
} from '../../shared/servicePrincipalCandidates'

// AppRun 専有型 ②「サービスプリンシパルの用意」の入力欄の下に出す、
// 「前のプロジェクトで使った ID」の案内・選択と、「新しく作る」リンク（2026-10-06・作者の決定）。
//
// 見た目だけを持つ部品（状態は持たない）。欄の値・保存・候補の取得は ServicePrincipalSection.tsx の
// useServicePrincipal が持ち（2026-10-07 にパネルから切り出した）、ここは props を描くだけ（掟10: 判断は
// shared/servicePrincipalCandidates.ts の純関数）。**保存へ通じる口（onPick・onPickManual）は、ユーザーの操作
// （onChange / onClick）の中でだけ呼ぶ**——マウント時・描画中に呼ぶと、開いただけで保存が走る
// （tests/servicePrincipalPicker.test.ts が構文木で固定している。useEffect・useRef・ref= もこの部品には置かない）。
// AppRunDedicatedPanel.tsx は巨大ファイルなので、②に足す新しい部分はこちらへ切り出した（CLAUDE.md「調査のしかた」）。
//
// 掟11（環境の独立）: ほかのプロジェクトの ID とプロジェクト名を出す理由は、
// shared/servicePrincipalCandidates.ts の冒頭に書いた（さくらのクラウドの「プロジェクト」の資源・作者の決定・秘密ではない）。

/**
 * 「新しく作る」の行き先: コントロールパネルの「サービスプリンシパル」の画面。
 *
 * 出典（掟1: 推測で URL を作らない・原本のリンクをそのまま使う）:
 *   さくらのクラウド マニュアル「AppRun専有型 クイックスタート」（更新 2026-04-21）
 *   https://manual.sakura.ad.jp/cloud/apprun-dedicated/getting_started.html
 *   の「サービスプリンシパルの設定」の1つ目の手順
 *   「さくらのクラウド ホームの左メニューから「サービスプリンシパル」をクリックします」の
 *   「サービスプリンシパル」が、このリンク（href）になっている。2026-10-06 に原本の HTML を取得して確かめた。
 *   （同じ手順を書いた https://manual.sakura.ad.jp/cloud/controlpanel/service-principal.html は
 *   画面への直接のリンクを持たず「左メニューから」とだけ書いている。）
 * 開き方は、この画面のほかの外部リンク（CONTROL_PANEL_URL など）と同じ `<a href>`。
 * main の will-navigate / setWindowOpenHandler が既定のブラウザへ流す（src/main/main.ts）。
 */
export const SERVICE_PRINCIPALS_URL = 'https://secure.sakura.ad.jp/cloud/?#/service-principals'

interface Props {
  /** 候補（新しい順）。空なら「別のプロジェクト・アカウントの ID は使えません」の一言と「新しく作る」リンクだけを出す。 */
  candidates: readonly ServicePrincipalCandidate[]
  /** 欄にいま入っている値。どの候補が選ばれているかは、これと各候補の ID を見比べて決める。 */
  value: string
  /** 候補を選んだ（欄へ入れて記録へ保存するのは呼び出し側）。 */
  onPick: (id: string) => void
  /** 「別の ID を入力する」を選んだ（欄を空にして入力へ進めるのは呼び出し側）。 */
  onPickManual: () => void
}

export default function ServicePrincipalPicker({ candidates, value, onPick, onPickManual }: Props) {
  const groupName = useId()
  const current = value.trim()
  const manualSelected = !candidates.some(c => c.id === current)

  return (
    <div className="space-y-1.5">
      {/* 候補が1つ: 欄に入れた旨を添える（書き換えたら、入れた旨はもう正しくないので消す） */}
      {candidates.length === 1 && current === candidates[0].id && (
        <p className="text-[11px] text-ink-secondary leading-relaxed">{singlePrefillNote(candidates[0])}</p>
      )}

      {/* 候補が複数: ID とそれを使っているプロジェクト名を並べて選ぶ（既定は先頭＝いちばん新しいもの） */}
      {candidates.length >= 2 && (
        <fieldset className="space-y-1 rounded-lg border border-line bg-overlay p-2.5">
          <legend className="px-1 text-[11px] font-medium text-ink-secondary">前のプロジェクトで使った ID（どれを使いますか？）</legend>
          {candidates.map((c, i) => (
            <label key={c.id} className="flex items-start gap-2 text-xs text-ink cursor-pointer">
              <input
                type="radio"
                name={groupName}
                checked={current === c.id}
                onChange={() => onPick(c.id)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <code className="font-mono select-text">{c.id}</code>
                <span className="text-ink-secondary">　{formatProjectNames(c.projectNames)}</span>
                {/* 並びの根拠は .sakuraide.json のファイルの更新時刻（ID を入れた時刻ではない）。
                    なので「いちばん新しい ID」とは言わず、実際の意味（記録がいちばん最近更新された）で書く。 */}
                {i === 0 && c.updatedAtMs !== null && <span className="text-ink-muted">　（いちばん最近更新された記録）</span>}
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
            <input
              type="radio"
              name={groupName}
              checked={manualSelected}
              onChange={() => onPickManual()}
              className="mt-0.5"
            />
            <span>別の ID を入力する</span>
          </label>
        </fieldset>
      )}

      {/* どの場合も（候補が0件でも）: 別のアカウント・別のプロジェクトの ID は使えない（仕様「どの場合も一言添える」） */}
      <p className="text-[11px] text-ink-muted leading-relaxed">{ACCOUNT_MISMATCH_NOTE}</p>

      <a
        href={SERVICE_PRINCIPALS_URL}
        className="inline-block text-[11px] text-sakura hover:underline"
      >＋ 新しく作る（コントロールパネルの「サービスプリンシパル」を開く ↗）</a>
    </div>
  )
}
