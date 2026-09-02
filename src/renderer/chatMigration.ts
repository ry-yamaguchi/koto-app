// チャット履歴の読み込み優先順位（ファイル→localStorage(旧形式・移行)→空）を決める純粋ロジック。
// window/electronAPI/localStorage に一切触れないため、Vitest（node環境）でそのままテストできる。
// 実際のIO（ファイル読み込み・localStorage参照・移行後の保存＆旧キー削除）は chatConvClient.ts
// （IDEのプロジェクト別チャット・B'-3e-a 以降は単独チャットのセッションも同様）が担う。

/** JSON文字列を配列としてパースする。null/未指定/配列でない/パース不能なら null。 */
export function parseJsonArray(raw: string | null | undefined): any[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export type ChatSource<T> =
  | { kind: 'file'; data: T[] }
  | { kind: 'migrate'; data: T[] } // localStorage（旧形式）にのみ存在。呼び出し側でファイルへ保存し、旧キーを消す
  | { kind: 'empty' }

/**
 * ファイル優先→localStorage(あれば移行)→空、の判定を行う純粋関数。
 * fileData: ファイルから読めた配列（無ければ null）
 * legacyData: localStorage（旧形式）から読めた配列（無ければ null）
 */
export function resolveChatSource<T>(fileData: T[] | null, legacyData: T[] | null): ChatSource<T> {
  if (fileData !== null) return { kind: 'file', data: fileData }
  if (legacyData !== null) return { kind: 'migrate', data: legacyData }
  return { kind: 'empty' }
}
