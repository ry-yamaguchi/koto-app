import React, { useId } from 'react'

// 桜の花びら1枚（先端にゆるやかな切れ込み・基部が原点側）。角を立てず柔らかい輪郭。
const PETAL_D = 'M0,6 C-13,-2 -16,-22 -8,-35 Q-3,-30 0,-29 Q3,-30 8,-35 C16,-22 13,-2 0,6 Z'

/**
 * アプリの独自ロゴ（桜の一輪）。アプリアイコン build/icon.svg と同じ淡いパステル調に合わせ、
 * 奥に薄い花弁層＋手前にグラデーション花弁の二層で「ふんわり」させる
 * （2026-07-13 ユーザーフィードバック: 単色フラットの一輪は硬い → icon.svg の柔らかい雰囲気に）。
 * size/mono はプロップ互換のまま（mono=true は currentColor 単色・単層）。
 */
export default function SakuraLogo({ size = 18, mono = false }: { size?: number; mono?: boolean }) {
  // 複数個所で同時描画されるため、グラデーションIDはインスタンスごとに一意にする。
  const gid = useId().replace(/[:]/g, '')
  const angles = [0, 72, 144, 216, 288]
  return (
    <svg width={size} height={size} viewBox="-48 -48 96 96" fill="none" aria-label="Koto">
      {!mono && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffc2d0" />
            <stop offset="100%" stopColor="#ff8da3" />
          </linearGradient>
        </defs>
      )}
      {/* 奥の花弁層（淡く・少し大きく・36度ずらし）＝ふんわり感。mono時は省略 */}
      {!mono && (
        <g opacity="0.85">
          {angles.map(a => (
            <path key={a} d={PETAL_D} fill="#fbd9e1" transform={`rotate(${a + 36}) translate(0,-7) scale(1.12)`} />
          ))}
        </g>
      )}
      {/* 手前の花弁層 */}
      <g>
        {angles.map(a => (
          <path key={a} d={PETAL_D} fill={mono ? 'currentColor' : `url(#${gid})`} transform={`rotate(${a}) translate(0,-7)`} />
        ))}
      </g>
      {!mono && (
        <>
          <circle r="5.5" fill="#ffffff" opacity="0.9" />
          <circle r="3" fill="#f09db1" />
        </>
      )}
    </svg>
  )
}
