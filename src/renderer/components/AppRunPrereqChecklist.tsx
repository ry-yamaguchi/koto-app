import React from 'react'
import CopyButton from './CopyButton'
import FailureLines from './FailureLines'
import { failureCopyNow } from '../failureCopy'
import { registryCreateNote } from '../../shared/cloudCost'

// ── 前提チェックリスト（構築時：内蔵ビルダー / レジストリ登録） ──
// Docker のインストールも Dockerfile も不要。IDE 同梱のビルダーで組み立てる。
//
// 「レジストリ登録」の行が ✗ のあいだは、月額と、使い終わったときの次の操作を**常に**出す（`registryCreateNote`）。
// 「🛠 レジストリを自動作成」は確認の窓を通らずに作るので、金額がボタンの hover にしか無いと、押す前に目に入らない。
export default function AppRunPrereqChecklist({
  prereqs,
  onOpenCredentials,
  onAutoCreateRegistry,
  regCreating,
  regNotice,
  regNoticeFailed = false,
  keyReady,
}: {
  prereqs: { builderMode: 'builtin' | 'docker'; builder?: boolean; docker?: boolean; dockerfile?: boolean; registry: boolean } | null
  onOpenCredentials: () => void
  onAutoCreateRegistry: () => void
  regCreating: boolean
  regNotice: string
  /** regNotice が失敗の知らせのとき true（コピーに版と日時を添える）。成功の知らせはそのまま写す。 */
  regNoticeFailed?: boolean
  keyReady: boolean
}) {
  const isDocker = prereqs?.builderMode === 'docker'
  const registry = !!prereqs?.registry
  const mark = (ok: boolean) =>
    ok ? <span className="text-brand-green font-semibold">✓</span> : <span className="text-brand-red font-semibold">✗</span>
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">
      <p className="text-[11px] font-semibold text-ink-secondary">{isDocker ? '公開するための前提' : '公開するための前提（Docker は不要です）'}</p>
      <ul className="space-y-1.5 text-xs">
        {isDocker ? (
          <>
            <li className="flex items-center gap-2 flex-wrap">
              {mark(!!prereqs?.docker)}
              <span className="text-ink">Docker 導入</span>
              {!prereqs?.docker && <a href="https://www.docker.com/products/docker-desktop/" className="text-sakura hover:underline">Docker Desktop を入手</a>}
            </li>
            <li className="flex items-center gap-2 flex-wrap">
              {mark(!!prereqs?.dockerfile)}
              <span className="text-ink">Dockerfile</span>
              <span className="text-ink-muted">プロジェクト直下に Dockerfile が必要</span>
            </li>
          </>
        ) : (
          <li className="flex items-center gap-2 flex-wrap">
            {mark(!!prereqs?.builder)}
            <span className="text-ink">内蔵ビルダー</span>
            <span className="text-ink-muted">Koto に内蔵のビルド機能</span>
          </li>
        )}
        <li className="flex items-center gap-2 flex-wrap">
          {mark(registry)}
          <span className="text-ink">レジストリ登録</span>
          {!registry ? (
            <>
              <button
                onClick={onAutoCreateRegistry}
                disabled={regCreating || !keyReady}
                className="px-2 py-0.5 rounded bg-sakura/10 text-sakura hover:bg-sakura/20 disabled:opacity-50"
                title={!keyReady
                  ? '先に認証情報でクラウドのAPIキーを登録してください'
                  : 'Kotoがコンテナレジストリを自動作成します'}
              >{regCreating ? '作成中…' : '🛠 レジストリを自動作成'}</button>
              <button onClick={onOpenCredentials} className="text-ink-muted hover:underline">手動で登録</button>
              <p className="w-full text-[11px] text-ink-secondary select-text break-words">{registryCreateNote()}</p>
            </>
          ) : null
            // ── 登録済みのときはボタンを出さない（2026-08-09 Ryosuke の指摘から）──────
            // 以前はここに「↻ ユーザー再設定」を常設していたが、
            //   ・平常時に押す理由が無い（押して得することが何も無い）
            //   ・ラベルに反して、レジストリが見つからなければ**新規作成する**＝課金が始まる
            //   ・接続情報を上書きする唯一の場所で、2026-08-06 の誤 push・誤削除の起点になった
            // という三重の問題があった。必要になるのは push が 401 になったときと、
            // 別プロジェクトのレジストリを指しているときだけなので、**そのエラーの中に出す**
            // （公開の失敗の案内にある「↻ レジストリを設定し直す」）。困ったときだけ現れるものにする。
          }
        </li>
      </ul>
      {regNotice && (
        <div className="flex items-start gap-1.5">
          <p className="text-[11px] text-ink-secondary flex-1 select-text whitespace-pre-wrap break-words"><FailureLines text={regNotice} /></p>
          <CopyButton text={regNotice} getText={regNoticeFailed ? () => failureCopyNow(regNotice) : undefined} />
        </div>
      )}
    </div>
  )
}
