// hintTimer.ts — 画面の下に出す案内を、一定時間で消す小さな部品。
// 案内が続けて出たとき、先の案内の消す時計が後の案内を早く消さないよう、出すたびに前の時計を止めて掛け直す。

/** 案内を出して、`ms` ミリ秒後に消す。出すたびに前の時計を止める。 */
export function createHintTimer(set: (text: string | null) => void, ms: number): (text: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return text => {
    if (timer !== undefined) clearTimeout(timer)
    set(text)
    timer = setTimeout(() => { timer = undefined; set(null) }, ms)
  }
}
