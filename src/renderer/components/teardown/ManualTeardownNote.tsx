// ManualTeardownNote.tsx — Koto から破棄できない公開先（Vercel・レンタルサーバ）の、どこで消せばよいかの案内。
//
// 段階3A（3A-3）。設計書: docs/teardown-unify-plan.md の 10.9.6。
// 案内の中身は shared/teardownSupport.ts の manualTeardownGuide が持つ（ここは描くだけ。判断を持たない）。
// 破棄できる公開先には何も描かない。破棄ボタンは出さない（押しても何も起きないボタンを並べない）。
// 「📡 公開したもの一覧」の群れの見出しの下と、プロジェクトの削除の公開先の行で、同じ文・同じ見た目になる。
// storageTornDown（0.6.24 A-9）は、プロジェクトの削除で、保存場所も一緒に破棄する回だけ真にして渡す（Vercel の案内の最後の文「保存場所…は残ります」を言わない）。
// 真かどうかの判断は呼び手（ダイアログ。projectDeleteWords.ts の vercelStorageTornDown）が持つ。📡 は渡さない＝今のまま。
import type { PublishTargetKind } from '../../publishStatus'
import { teardownSupport, manualTeardownGuide } from '../../../shared/teardownSupport'

export default function ManualTeardownNote({ target, className, storageTornDown }: { target: PublishTargetKind; className?: string; storageTornDown?: boolean }) {
  if (teardownSupport(target) !== 'manual') return null
  return (
    <p className={`text-[11px] text-ink-muted leading-relaxed select-text${className ? ` ${className}` : ''}`}>
      ℹ️ {manualTeardownGuide(target, { storageTornDown })}
    </p>
  )
}
