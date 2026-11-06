import React from 'react'
import { splitFailureDetail, FAILURE_DETAIL_LABEL } from '../../shared/failureDetail'

// 失敗の文と、そのすぐ下の小さな「詳細: <原文>」の行を描く（分け方は shared/failureDetail.ts の1か所）。
// 親の要素（<p>・<span>・赤い帯）の中にそのまま置ける断片を返す。文の側は親の見た目（色・改行の扱い）を引き継ぐ。
// 詳細の行は select-text で、文と一緒に選んでコピーできる。

export const FAILURE_DETAIL_CLASS = 'block mt-0.5 text-[10px] leading-snug opacity-80 break-all select-text'

export default function FailureLines({ text, detailClassName }: {
  text: string
  /** 詳細の行の見た目を置き場所に合わせて変えるとき（省略時は小さく薄い1行） */
  detailClassName?: string
}) {
  const { text: main, detail } = splitFailureDetail(text)
  return (
    <>
      {main}
      {detail && <span className={detailClassName ?? FAILURE_DETAIL_CLASS}>{FAILURE_DETAIL_LABEL}{detail}</span>}
    </>
  )
}
