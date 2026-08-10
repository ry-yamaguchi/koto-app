import React, { useState } from 'react'
import SakuraLogo from './SakuraLogo'

interface Props {
  onSetApiKey: (key: string) => void
  onClose: () => void          // 「あとで設定する」も含め閉じる（呼び出し側でonboardedフラグを立てる）
  onCreateProject: () => void  // 完了時「最初のプロジェクトを作る」
  /** 「他のAPIキーも登録する」→ 認証情報（APIキー）ダイアログを開く（ユーザー要望 2026-07-13:
   *  Claude・GitHub 等のキーも初期にまとめて登録しておくと、その後の作業効率が良いため）。 */
  onOpenCredentials: () => void
}

export default function OnboardingModal({ onSetApiKey, onClose, onCreateProject, onOpenCredentials }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const models = await window.electronAPI.sakura.models(key.trim())
      setResult({ ok: true, msg: `✅ 接続できました（利用可能なモデル: ${models.length}個）` })
    } catch (e: any) {
      setResult({ ok: false, msg: `❌ 接続できませんでした（キーをご確認ください）: ${e?.message ?? String(e)}` })
    } finally {
      setTesting(false)
    }
  }

  const dot = (n: number) => (step === n ? '●' : '○')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[520px] bg-elevated rounded-2xl border border-line shadow-xl p-8 fade-in">
        <div className="flex justify-center mb-6 text-sm tracking-widest text-ink-muted select-none">
          {dot(1)}{dot(2)}{dot(3)}
        </div>

        {step === 1 && (
          <div className="text-center">
            <div className="flex justify-center mb-4">
              <SakuraLogo size={48} />
            </div>
            <h2 className="text-xl font-bold text-ink mb-3">Koto へようこそ</h2>
            <p className="text-sm text-ink-secondary leading-relaxed mb-5">
              AIと一緒にWebサイトやアプリを作り、さくらインターネットのサービスでそのまま公開できるアプリです。
            </p>
            <ul className="text-sm text-ink-secondary space-y-2 text-left bg-surface border border-line rounded-xl p-4 mb-6">
              <li>① 作る（AIに日本語で依頼）</li>
              <li>② 試す（ワンクリックで動作確認）</li>
              <li>③ 公開（さくらのサーバへ）</li>
            </ul>
            <p className="text-[11px] text-ink-muted mb-4">
              Koto は個人開発の非公式ツールです（さくらインターネットの製品ではありません）。
            </p>
            <div className="flex items-center justify-between">
              <button onClick={onClose} className="text-sm text-ink-muted hover:text-ink transition-colors">
                あとで設定する
              </button>
              <button
                onClick={() => setStep(2)}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity"
              >
                はじめる →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold text-ink mb-3">APIキーの取得</h2>
            <p className="text-sm text-ink-secondary mb-4">
              AIを使うには、さくらのAI Engine のAPIキー（無料で取得可）が必要です
            </p>
            <ol className="text-sm text-ink-secondary space-y-3 list-decimal list-inside bg-surface border border-line rounded-xl p-4 mb-6">
              <li>
                <a href="https://ai.sakura.ad.jp/" className="text-sakura hover:text-sakura-soft underline">さくらのAI Engine</a>
                {' '}にアクセスしてログイン（さくらのアカウント）
              </li>
              <li>コントロールパネルでAPIキー（アカウントトークン）を発行</li>
              <li>コピーして次の画面で貼り付け</li>
            </ol>
            <div className="flex items-center justify-between">
              <button onClick={() => setStep(1)} className="text-sm text-ink-muted hover:text-ink transition-colors">
                ← 戻る
              </button>
              <button
                onClick={() => setStep(3)}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity"
              >
                キーを持っています →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold text-ink mb-3">キーの登録と接続テスト</h2>
            <label className="text-[11px] font-medium text-ink-secondary">APIキー</label>
            <div className="mt-1 mb-3 flex items-center gap-1.5">
              <input
                type={show ? 'text' : 'password'}
                value={key}
                onChange={e => { setKey(e.target.value); setResult(null) }}
                placeholder="アカウントトークン"
                className="flex-1 bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura transition-colors"
              />
              <button
                onClick={() => setShow(s => !s)}
                className="text-xs text-ink-muted hover:text-ink w-8 h-8 rounded-lg hover:bg-overlay flex-none"
                title={show ? '隠す' : '表示'}
              >
                {show ? '🙈' : '👁'}
              </button>
            </div>

            <button
              onClick={runTest}
              disabled={testing || !key.trim()}
              className="text-sm text-sakura border border-sakura/50 rounded-lg px-3 py-1.5 hover:bg-overlay disabled:opacity-50 transition-colors"
            >
              {testing ? '接続中…' : '接続テスト'}
            </button>

            {result && (
              <p className={`text-xs mt-3 ${result.ok ? 'text-brand-green' : 'text-brand-red'}`}>
                {result.msg}
              </p>
            )}

            {result?.ok && (
              <>
                <button
                  onClick={() => { onSetApiKey(key.trim()); onCreateProject() }}
                  className="w-full mt-5 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity"
                >
                  保存して最初のプロジェクトを作る
                </button>
                {/* Claude・GitHub 等のキーも初期にまとめて登録しておきたい人向けの導線。
                    キーを保存してから認証情報ダイアログへ（オンボーディング自体は閉じる）。 */}
                <button
                  onClick={() => { onSetApiKey(key.trim()); onOpenCredentials() }}
                  className="w-full mt-2 py-2.5 rounded-xl text-sm font-medium text-ink-secondary bg-surface border border-line hover:text-ink transition-colors"
                >
                  🔑 他のAPIキーも登録する（Claude・GitHub など）
                </button>
              </>
            )}

            <div className="flex items-center justify-between mt-4">
              <button onClick={onClose} className="text-sm text-ink-muted hover:text-ink transition-colors">
                あとで設定する
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => setStep(2)} className="text-sm text-ink-muted hover:text-ink transition-colors">
                  ← 戻る
                </button>
                <button
                  onClick={() => { onSetApiKey(key.trim()); onClose() }}
                  disabled={!result?.ok}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary bg-surface border border-line hover:text-ink disabled:opacity-50 transition-colors"
                >
                  保存して閉じる
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
