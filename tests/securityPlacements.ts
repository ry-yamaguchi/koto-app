import type { TargetId } from '../src/renderer/targetProfiles'

// 🛡 の点検の置き場所の表。画面のソースにある呼び出しの文字列そのまま。
// 試験は tests/securityPlacementTable.test.ts。

const C = 'src/renderer/components/'

export type SecurityPlacement =
  | { kind: 'section'; file: string; call: string; unusedCall: string | null }
  | { kind: 'none'; reason: string; file?: string }

export const SECURITY_PLACEMENTS: Record<TargetId, SecurityPlacement> = {
  local: { kind: 'none', reason: '公開の画面が無い（あとで決める、の選択）。' },
  'sakura-rental': {
    kind: 'section',
    file: `${C}PublishModal.tsx`,
    call: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />',
    unusedCall: '<UnusedFilesSection projectDir={projectDir} />',
  },
  'sakura-apprun': {
    kind: 'section',
    file: `${C}AppRunPanel.tsx`,
    call: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="手順4" />',
    unusedCall: '<UnusedFilesSection projectDir={projectDir} stepNo="手順5" />',
  },
  'sakura-apprun-dedicated': {
    kind: 'section',
    file: `${C}AppRunDedicatedPanel.tsx`,
    call: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />',
    unusedCall: null,
  },
  'sakura-vps': {
    kind: 'none',
    file: `${C}VpsPanel.tsx`,
    reason: '公開の実装がまだ無い。公開の実装を入れるときに節を足す。',
  },
  'sakura-cloud': { kind: 'none', reason: '公開の画面が無い（公開先の説明だけ）。' },
  hanamii: {
    kind: 'section',
    file: `${C}HanamiiPanel.tsx`,
    call: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="手順3" />',
    unusedCall: '<UnusedFilesSection projectDir={projectDir} stepNo="手順4" />',
  },
  vercel: {
    kind: 'section',
    file: `${C}VercelPanel.tsx`,
    call: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="手順2" />',
    unusedCall: '<UnusedFilesSection projectDir={projectDir} stepNo="手順3" />',
  },
  other: { kind: 'none', reason: '公開の画面が無い（さくら以外の環境は手元の案内だけ）。' },
}

// GitHub への保存は公開先ではないので、表とは別の行にする。
export const GITHUB_SAVE_PLACEMENT = {
  file: `${C}GithubSaveModal.tsx`,
  call: '<GithubSaveScan projectDir={projectDir} />',
}
