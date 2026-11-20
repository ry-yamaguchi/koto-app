// publishScanTypes.ts — 公開されるファイルの点検の結果の型（型だけ）。

import type { RuntimeMode, ScanFinding, ScanScope } from './securityFindings'

export type PublishScanScope = ScanScope

export interface PublishScanDone {
  state: 'done'
  /** 点検した範囲 */
  scope: ScanScope
  /** 動かし方の見立て。'github' では null */
  mode: RuntimeMode | null
  /** 一覧に入ったファイルの数 */
  listed: number
  /** 中身を点検したファイルの数 */
  scanned: number
  /** 並べ済み。PUBLISH_SCAN_FINDINGS_LIMIT まで */
  findings: ScanFinding[]
  /** 指摘の全部の数 */
  findingsTotal: number
  notScanned: {
    /** 大きすぎ（名前は PUBLISH_SCAN_NAME_LIMIT まで・数は全部） */
    tooLarge: string[]
    tooLargeCount: number
    /** 読めない（リンクで外を指す・権限など） */
    unreadable: string[]
    unreadableCount: number
    /** 文字として読めない（名前は PUBLISH_SCAN_NAME_LIMIT まで・数は全部） */
    binary: string[]
    binaryCount: number
    /** 見本の名前のため読まなかった（名前は PUBLISH_SCAN_NAME_LIMIT まで・数は全部） */
    sample: string[]
    sampleCount: number
    /** 行が長すぎて、訪問者の入力の書き方を見ていない（名前は PUBLISH_SCAN_NAME_LIMIT まで・数は全部） */
    longLine: string[]
    longLineCount: number
    /** 合計の上限を超えたので読まなかった（名前は PUBLISH_SCAN_NAME_LIMIT まで・数は全部） */
    overTotal: string[]
    overTotalCount: number
    /** 一覧が上限・深さで切れた */
    listTruncated: boolean
  }
}

export type PublishScanReply = PublishScanDone | { state: 'bad-dir' } | { state: 'failed'; message: string }
