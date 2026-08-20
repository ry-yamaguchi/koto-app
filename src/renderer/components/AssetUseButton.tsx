// AssetUseButton.tsx — 添付した画像を「プロジェクトで使う」印。
//
// ── なぜチェックボックスなのか（2026-08-19 実機・Ryosuke 指摘）──────────
// 「『画像を使う』はチェックボックスの方が良いのではないだろうか？」
//
// 送信するまで**入(オン)のまま待つ**印なので、押すたびに姿が変わるボタンより、
// 入切がそのまま見えるチェックボックスの方が正しい。解除も自明になる。
//
// 送信済みの画像の方は「押した時点で入る」ただの操作なので、そちらはボタン
// （待たせる状態が無いものにチェックボックスを使うと、入っているように見えてしまう）。
//
// ── 確認画面をやめた理由（同日）────────────────────────────────────────
// 「アプリで使えば公開されるのは自明だし、何も考えずに送信ボタンを押せば
//   勝手に添付されるだけになると思うがどうか？」→ そのとおりにした。
// 公開したくない画像は AI に頼めば `素材（公開しません）/` へ置ける。

import React from 'react'
import { ASSET_USE_LABEL } from '../../shared/assetImport'

/**
 * 添付画像に付ける印（📎 と 送信 の間）。**送信のときに入る。**
 */
export function AssetUseCheckbox({ checked, count, onChange }: {
  checked: boolean
  /** 添付が複数枚のとき、枚数を出す（まとめて入ることが分かる）。 */
  count?: number
  onChange: (next: boolean) => void
}) {
  const many = (count ?? 1) > 1
  return (
    <label
      className="ml-1 inline-flex items-center gap-1.5 cursor-pointer select-none rounded-md px-1.5 py-1 hover:bg-overlay transition-colors"
      title="送信するときに、この画像をプロジェクトに入れて使えるようにします"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="accent-sakura w-3.5 h-3.5 cursor-pointer"
      />
      <span className={`whitespace-nowrap text-[11px] font-semibold ${checked ? 'text-sakura' : 'text-ink-secondary'}`}>
        {many ? `${ASSET_USE_LABEL}（${count}枚）` : ASSET_USE_LABEL}
      </span>
    </label>
  )
}

/**
 * 送信済みの画像の下に出すボタン。**押した時点で入る**（送信を待たない）。
 *
 * 送信すると添付欄は空になるので、ここが唯一の拠り所になる。
 */
export function AssetUseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="この画像をプロジェクトに入れて、アプリで使えるようにします"
      // **背景は必ず塗る**（2026-08-19 実測）。透かすと、ピンクの吹き出しの上で
      // ピンク文字になり**読めなくなった**（色: rgb(255,85,119) / 地: 同色10%）。
      className="mt-1 self-center whitespace-nowrap rounded-md border bg-base border-line px-2 py-0.5 text-[10px] font-semibold text-ink-secondary hover:border-sakura hover:text-sakura transition-colors"
    >{`📁 ${ASSET_USE_LABEL}`}</button>
  )
}
