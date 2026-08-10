// AIに渡す画像の取り込み・圧縮ユーティリティ。
// 大きな画像はトークン/保存サイズの無駄になるため、長辺を縮小してJPEG化する。

const MAX_DIM = 1280
const JPEG_QUALITY = 0.85

/** File（画像）を縮小済みの data URL に変換する。非画像は null。 */
export async function fileToDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null
  const raw = await readAsDataUrl(file)
  try {
    return await downscale(raw)
  } catch {
    return raw // 縮小に失敗しても元データで送る
  }
}

/**
 * 所見19: 添付候補のうち画像でないものの件数を数える純粋関数。
 * ドロップ/貼り付け/ファイル選択で非画像が混じっていた場合、ChatPanel/ChatApp 側で
 * 「画像ファイルのみ添付できます」という案内を出すために使う（fileToDataUrl は非画像を黙って null で捨てるため、
 * 呼び出し側だけでは何件スキップされたか分からなかった）。
 * File 全体ではなく `{ type: string }` を受け取ることで、DOM非依存のまま純粋関数としてテストできるようにする。
 */
export function countNonImageFiles(files: { type: string }[]): number {
  return files.filter(f => !f.type.startsWith('image/')).length
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function downscale(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height))
      if (scale >= 1) { resolve(dataUrl); return } // 既に十分小さい
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(dataUrl); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
    }
    img.onerror = reject
    img.src = dataUrl
  })
}
