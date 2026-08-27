// importProject.ts — 公開されているものをインポートするときの、画面側の判断（純ロジック）。
//
// ── なぜ切り出すのか（2026-08-24・dev-plan ④ 第3段階）────────────────────
// インポートの画面は「何が起きるか」を押す前に見せることが本体で、
// **その文言と記録の中身がいちばん間違えやすい**。JSX の中に書くと固定できないので、
// 文言も記録も純関数にしてテストで押さえる（掟10）。
//
// electron / DOM に依存しないこと（tests/importProject.test.ts の対象）。

import type { AdoptionPreview, AppRunSettings } from '../shared/publishImport'
import { PUBLISH_TARGET_CONSOLE, PUBLISH_TARGET_LABEL, type PublishTargetKind } from './publishStatus'
import { REGISTRY_MONTHLY_YEN } from '../shared/cloudCost'

export type ImportTarget = 'vercel' | 'sakura-apprun'

/**
 * インポートしたあと、利用者が何をしたいか（2026-08-24 Ryosuke 指摘）。
 *
 * ── なぜ聞くのか ──────────────────────────────────────────────────────
 * それまでの作りは「引っ越し・引き継ぎ」の一択を前提にしていて、
 * **次の公開が元を上書きする**ようになっていた。だが利用者がすることは
 * それだけではない（元は残して作り替えたい／手で編集していたものを Koto に移したい／
 * 中身を見たいだけ）。決めつけると、**元の公開を壊す罠**になる。
 *
 * 間違いの重さが左右で違う。`fork` のつもりで `update` になると**生きている公開が消える**が、
 * 逆はプロジェクトが1つ余分にできるだけで、元はそのまま動き続ける。
 * だから**既定値を置かず、利用者に選ばせる**。
 */
export type ImportIntent =
  /** いまの公開を、これから Koto で更新していく（引っ越し・引き継ぎ）。 */
  | 'update'
  /** 元はそのままにして、別物として公開する（作り替え・複製）。 */
  | 'fork'
  /** まだ決めていない（中を見たい・あとで決める）。 */
  | 'undecided'

/** 選択肢の見出しと説明（画面と AI への説明で同じものを使う）。 */
export const IMPORT_INTENTS: { id: ImportIntent; label: string; hint: string }[] = [
  { id: 'update', label: 'いまの公開を更新していく', hint: '引っ越し・引き継ぎ。公開すると、いま公開されているものが置き換わります' },
  { id: 'fork', label: '別物として公開する', hint: '元はそのまま。作り替え・複製に使います' },
  { id: 'undecided', label: 'まだ決めていない', hint: '中身を見てから、公開のときに決めます' },
]

/** インポート元（記録にも画面にも同じものを使う）。 */
export type ImportedSource = {
  target: ImportTarget
  /** 公開先での識別子（Vercel はデプロイID、AppRun はアプリID）。 */
  id: string
  /** 公開先での名前。 */
  name: string
  url: string | null
  /** いつ公開されたものか。 */
  publishedAt: string | null
  /** 剥がした包み（Vercel の `src/`、イメージの `usr/share/nginx/html` など）。 */
  stripped?: string | null
  fileCount: number
  /** AppRun のときだけ。取り戻せた公開設定。 */
  settings?: AppRunSettings | null
  /** このあと何をしたいか（**両方の公開先で聞く**）。 */
  intent?: ImportIntent | null
  /**
   * AppRun を**引き継げたか**（dev-plan ④ 第4段階）。
   *
   * `intent === 'update'` でも、引き継ぎに失敗することはある
   * （ポートが読めない・設定を書けない）。**選んだこと**と**できたこと**は違うので、
   * 記録も公開の記録も**できたほうだけ**を見る。
   */
  adopted?: boolean
}

/**
 * 中身の置き場所から、何を作ったものかを決める（純関数）。
 *
 * **推測ではなく、実際に取り出した場所から決める。** イメージの `app/` は
 * 常駐するアプリ（Node など）、`usr/share/nginx/html` などは静的なサイト。
 * Vercel のファイル直接アップロードは静的なサイトしか置けない。
 */
export function kindFromImport(target: ImportTarget, stripped: string | null | undefined): 'site' | 'app' {
  if (target === 'vercel') return 'site'
  return stripped === 'app' ? 'app' : 'site'
}

/**
 * インポートしたプロジェクトの `.sakuraide.json`（純関数）。
 *
 * ── Vercel と AppRun で書くものが違う理由 ─────────────────────────────
 * **Koto がその公開先を続けて面倒みられるときだけ、公開の記録（`publish.targets`）を書く。**
 *
 * - Vercel … 公開先は `publish.vercel.name` で決まる。これを書いておけば、
 *   次の公開は**同じプロジェクトを更新**する。記録を書いてよい。
 * - AppRun … どのアプリかは `.sakura-cloud/state.json`（Koto が作る内部の控え）で決まる。
 *   **引き継げた（`adopted`）ときだけ**それが手元にあるので、記録を書いてよい。
 *   引き継いでいないのに書くと、「📡 公開したもの」に**押しても何も起きない
 *   破棄ボタン**が並ぶ（2026-08-09 に一元化したときの戒めと同じ形）。
 *   ⚠️ **選んだこと（`intent`）ではなく、できたこと（`adopted`）で決める。**
 *
 * どちらの場合も `importedFrom` には**インポートした事実をそのまま**残す。
 *
 * ── Vercel は、さらに**利用者の目的**で分かれる（2026-08-24 Ryosuke 指摘）────
 * | 目的 | 公開名 | `publish.targets` |
 * |---|---|---|
 * | `update` いまの公開を更新していく | **元の名前** → 次の公開で置き換わる | 書く（実際に公開されている） |
 * | `fork` 別物として公開する | **新しいプロジェクト名** → 元は無傷 | **書かない**（まだ公開していない） |
 * | `undecided` まだ決めていない | 書かない → 公開のときに決める | 書かない |
 *
 * `fork` で `publish.targets` を書くと、**まだ公開していないものが
 * 「📡 公開したもの」に並ぶ**（幽霊になる）。書いてよいのは `update` だけ。
 */
export function buildImportedMeta(opts: {
  projectName: string
  source: ImportedSource
  importedAt: string
}): Record<string, unknown> {
  const { projectName, source, importedAt } = opts
  const meta: Record<string, unknown> = {
    name: projectName,
    description: '',
    kind: kindFromImport(source.target, source.stripped),
    target: source.target,
    createdAt: importedAt,
    importedFrom: {
      target: source.target,
      id: source.id,
      name: source.name,
      url: source.url,
      publishedAt: source.publishedAt,
      importedAt,
      fileCount: source.fileCount,
      stripped: source.stripped ?? null,
      ...(source.intent ? { intent: source.intent } : {}),
      ...(source.adopted ? { adopted: true } : {}),
      ...(source.settings ? { settings: source.settings } : {}),
    },
  }
  if (source.target === 'vercel' && source.intent === 'update') {
    meta.publish = {
      vercel: { name: source.name },
      targets: { vercel: { publishedAt: source.publishedAt, url: source.url } },
    }
  } else if (source.target === 'vercel' && source.intent === 'fork') {
    // **元を絶対に上書きしない。** 公開名は新しいプロジェクト名にしておく。
    // まだ公開していないので、公開の記録（targets）は書かない。
    meta.publish = { vercel: { name: projectName } }
  } else if (source.target === 'sakura-apprun' && source.adopted) {
    // 引き継げた＝このプロジェクトから更新も破棄もできる。**実際に公開されている**ので書く。
    meta.publish = {
      targets: { 'sakura-apprun': { publishedAt: source.publishedAt, url: source.url } },
    }
  }
  return meta
}

/**
 * インポートする前に見せる「これから何が起きるか」（純関数）。
 *
 * ── なぜ押す前に見せるのか ────────────────────────────────────────────
 * 8/21 の🛡と同じ理屈で、**押したあとにしか出ない断り書きは無いのと同じ**。
 * とくに AppRun の「秘密は取り戻せない」は、知らずに公開すると**動かないものが出る**。
 *
 * 文中の `**…**` は**強調したいところ**。画面は `emphasize()` を通して太字で出す。
 * （素の文字列のまま出すと `**` がそのまま見える。0.3.41 から出ていた・2026-08-25 実機）
 */
export function importPlanNotes(opts: {
  target: ImportTarget
  publishDirLabel: string
  fileCount?: number | null
  stripped?: string | null
  image?: string | null
  secretKeys?: string[]
  /** 公開先での名前（Vercel のプロジェクト名）。**どこが置き換わるかを名指しする**ために要る。 */
  publishName?: string | null
  /** このあと何をしたいか。まだ選んでいなければ未指定。 */
  intent?: ImportIntent | null
  /** これから作るプロジェクト名（`fork` のときの公開先になる）。 */
  projectName?: string | null
  /** 引き継ぎの見立て（AppRun のみ・`import:inspect` が返す）。 */
  adopt?: AdoptionPreview | null
}): string[] {
  const notes: string[] = []
  if (opts.target === 'vercel') {
    notes.push(
      typeof opts.fileCount === 'number'
        ? `公開されている ${opts.fileCount} 個のファイルを取り出して、新しいプロジェクトの「${opts.publishDirLabel}」へ置きます。`
        : `公開されているファイルを取り出して、新しいプロジェクトの「${opts.publishDirLabel}」へ置きます。`,
    )
    if (opts.stripped) {
      notes.push(`Vercel 側で付いた「${opts.stripped}/」の階層は外して置きます（元と同じ形に戻します）。`)
    }
    // ⚠️ **公開したときに何が起きるかは、選んだ目的で変わる**（2026-08-24 Ryosuke 指摘）。
    // 決めつけると、元の公開を壊す罠になる。
    if (opts.intent === 'fork') {
      notes.push(`Koto から公開すると、${opts.projectName ? `「${opts.projectName}」という` : ''}`
        + `**別の新しい Vercel プロジェクト**になります。`
        + `${opts.publishName ? `いまの「${opts.publishName}」は、そのまま公開され続けます。` : '元の公開はそのまま残ります。'}`)
    } else if (opts.intent === 'update') {
      notes.push(opts.publishName
        ? `Koto から公開すると、Vercel のプロジェクト「${opts.publishName}」が**置き換わります**。`
        : 'Koto から公開すると、いま公開されているページが置き換わります。')
    } else if (opts.intent === 'undecided') {
      notes.push('公開先は、③公開の画面で決めます。そのままだと**別の新しいプロジェクト**として公開されるので、'
        + `${opts.publishName ? `いまの「${opts.publishName}」` : '元の公開'}はそのまま残ります。`)
    }
  } else {
    notes.push(
      opts.image
        ? `いま公開されているイメージ（${opts.image}）を取り出して、中の公開物だけを「${opts.publishDirLabel}」へ置きます。`
        : `いま公開されているイメージを取り出して、中の公開物だけを「${opts.publishDirLabel}」へ置きます。`,
    )
    notes.push('取り出せるのは公開されている状態のものです。組み立てる前のファイルは戻りません。')
    notes.push('ポート・環境変数・規模などの設定は控えます。')
    const keys = opts.secretKeys ?? []
    if (keys.length) {
      notes.push(`⚠️ 秘密の値（${keys.length}件: ${keys.join(', ')}）は取り戻せません。公開する前に入れ直してください。`)
    }

    // ── ここから先は、選んだ目的で変わる（**選ぶまでは何も言わない**）──────
    // 決めつけて書くと、選ばれなかったほうの結末を読ませることになる。
    const adopt = opts.adopt ?? null
    if (opts.intent === 'update' && adopt?.blocker) {
      // **選んでも引き継げないことがある。黙って別物にしない。**
      notes.push(`⚠️ ${adopt.blocker}`)
    }
    const adopting = opts.intent === 'update' && !adopt?.blocker
    if (adopting) {
      // ── 引き継ぐ（dev-plan ④ 第4段階）────────────────────────────────
      // **いま動いているアプリそのもの**を、このプロジェクトから更新できるようにする。
      notes.push('公開されていたときの設定（ポート・環境変数・入れ物の大きさ・健康診断の場所）を'
        + '**そのまま引き継ぎます**。')
      // ⚠️ 「アプリが**置き換わります**」とは書かない（2026-08-25 Ryosuke 実機指摘）。
      // アプリそのものが作り直されるように読める。入れ替わるのは**中身**で、
      // 公開の確認画面の「再デプロイ（最新の内容を反映）」とも言葉が合わない。
      notes.push(opts.publishName
        ? `Koto から公開すると、いま動いているアプリ「${opts.publishName}」が、`
          + '**このプロジェクトの内容で更新されます**。**公開のアドレス（URL）は変わりません。**'
        : 'Koto から公開すると、いま動いているアプリが**このプロジェクトの内容で更新されます**。'
          + '**公開のアドレス（URL）は変わりません。**')
      notes.push(adopt?.reusesRegistry === false
        ? `イメージの置き場が1つ増えるため、月額${REGISTRY_MONTHLY_YEN}円（税込）が上乗せされます。`
        : '**月額は増えません**（いまのイメージの置き場を、そのまま使います）。')
      if (adopt && adopt.specName !== adopt.appName) {
        notes.push(`Koto の中での公開名は「${adopt.specName}」になります`
          + `（さくら側のアプリ名「${adopt.appName}」は変わりません）。`)
      }
      for (const w of adopt?.warnings ?? []) notes.push(w)
    } else if (opts.intent) {
      // `fork` / `undecided`、および「引き継ぎたかったが引き継げなかった」とき。
      //
      // ⚠️ **利用者に関係があるのは URL とお金**（2026-08-24 Ryosuke 指摘）。
      // 「別の新しいアプリとして作られます」はシステム側の言い分で、
      // 利用者は「自分のサイトを更新している」と受け取る。それでよい。
      // 言わなければならないのは、**アドレスが変わること**と**費用が増えること**。
      notes.push('インポートしたあとも、手を入れて公開していけます。ただし公開すると'
        + '**アドレス（URL）が変わります**。いま公開されているアドレスは、古い内容のまま残ります。')
      notes.push(`いまのアプリも残るので、月額${REGISTRY_MONTHLY_YEN}円（税込）が上乗せされます`
        + '（イメージの置き場が1つ増えるため）。要らなくなったら、'
        + 'さくらのクラウドのコントロールパネルで古いほうを消してください。')
    }
  }
  notes.push('公開先には何も作らず、何も消しません（読み取るだけです）。')
  return notes
}

/** 取り込んだあとに見せる知らせ（純関数）。**うまくいかなかったことも必ず出す。** */
export function importDoneNotes(opts: {
  fileCount: number
  failed?: string[]
  historySnapshotId?: string | null
  historyNote?: string | null
  /** AppRun を引き継げたか（dev-plan ④ 第4段階）。 */
  adopted?: boolean
  /** 引き継げなかった理由（**黙って省かない**）。 */
  adoptNote?: string | null
}): string[] {
  const notes: string[] = [`${opts.fileCount} 個のファイルをインポートしました。`]
  const failed = opts.failed ?? []
  if (failed.length) {
    notes.push(`取り出せなかったファイルが ${failed.length} 件あります: ${failed.slice(0, 5).join(', ')}`
      + (failed.length > 5 ? ' ほか' : ''))
  }
  // **「引き継ぐ」を選んだのに引き継げていない**ことを、黙って通さない。
  if (opts.adopted) {
    notes.push('このアプリを引き継ぎました。ここから公開すると、いま動いているアプリが'
      + '更新されます（公開のアドレスは変わりません）。')
  } else if (opts.adoptNote) {
    notes.push(opts.adoptNote)
  }
  if (opts.historySnapshotId) {
    notes.push('🕘 履歴に「公開されていたものをインポートした時点」を作りました。何をしても、ここへ戻せます。')
  } else if (opts.historyNote) {
    notes.push(opts.historyNote)
  }
  return notes
}

/** インポートしたあと、その公開先をどこで見られるか（純関数）。 */
export function importConsoleLink(target: ImportTarget): { label: string; url: string } {
  const t = target as PublishTargetKind
  return { label: PUBLISH_TARGET_LABEL[t], url: PUBLISH_TARGET_CONSOLE[t] }
}

/**
 * インポートしたプロジェクトを、AI へ正しく伝えるための文脈（純関数）。
 *
 * ── なぜ要るか（2026-08-24 Ryosuke 指摘）────────────────────────────────
 * 記録（`importedFrom`）は残していたのに、**AI には1つも渡していなかった**。
 * AI から見ると、ふつうに新規作成したプロジェクトと区別がつかない。
 *
 * ── 「触るな」で終わらせない（同日 Ryosuke 再指摘）──────────────────────
 * 最初の版は「生成物や `node_modules` は直接編集しないでください」と書いていた。
 * だが**代わりに何をすればよいかを書いていない**ので、AI は無視するか止まるだけ。
 * しかも一括りにしたせいで、**直してよい HTML/CSS まで触らなくなる**。
 * 種類ごとに「これはこう扱う」と書き分ける。
 *
 * ⚠️ **環境変数は名前だけ渡し、値は渡さない。** さくらは env と secret を
 * 分けているが、利用者が env に秘密を入れていることはありうる。
 * 「秘密の中身を外部AIへ送らない」（掟10）に倒す。
 *
 * 毎回の依頼の先頭に付くので、**振る舞いが変わることだけ**を書く。
 */
export function importedContext(importedFrom: unknown): string {
  const f = importedFrom as any
  if (!f || typeof f !== 'object') return ''
  const target: ImportTarget = f.target === 'sakura-apprun' ? 'sakura-apprun' : 'vercel'
  const where = PUBLISH_TARGET_LABEL[target as PublishTargetKind]
  const when = typeof f.importedAt === 'string' ? f.importedAt.slice(0, 10) : ''
  const who = typeof f.name === 'string' && f.name ? `（${f.name}）` : ''

  const lines: string[] = [
    '# このプロジェクトはインポートしたものです',
    `${when ? when + ' に' : ''}${where}${who}で公開されていたものを取り込みました。あなたが作ったものではありません。`,
  ]

  // ── 利用者が何をしたいか（決めつけない・最初に確かめさせる）────────────
  const intent: ImportIntent | null = ['update', 'fork', 'undecided'].includes(f.intent) ? f.intent : null
  if (intent) {
    const said = intent === 'update'
      ? '**いまの公開を、これから Koto で更新していく**（引っ越し・引き継ぎ）'
      : intent === 'fork'
        ? '**元はそのままにして、別物として公開する**（作り替え・複製）'
        : '**まだ決めていない**（中身を見てから決める）'
    lines.push(`- 利用者が選んだ目的: ${said}`)
    lines.push('- **最初の返事で、この目的で合っているかを一言で確かめてください。**'
      + '違っていれば、そのやり方に切り替えます（例: 手で編集していたものを Koto へ移したい、中身を見たいだけ、など）。')
  } else {
    lines.push('- 利用者がこのあと何をしたいかは、まだ分かりません。'
      + '**最初の返事で1つだけ確かめてください**（いまの公開を更新していく／別物として作り替える／'
      + '手で編集していたものを Koto へ移す／中身を見たいだけ）。')
  }

  // ── ファイルの扱い（**種類ごとに、何をすればよいかまで書く**）──────────
  lines.push('- ここにあるファイルは**実際に公開されていたもの**です。利用者の資産なので、'
    + '頼まれていない作り直し・整理はしないでください。まず読んでから、頼まれたところだけ直します。')
  lines.push('- そのまま読める形のもの（HTML・CSS・画像・ふつうの JavaScript）は**これが原本**です。'
    + '守るために避ける必要はありません。**頼まれたら遠慮なく直してください。**')
  lines.push('- 圧縮・結合された生成物（1行に潰れた `.js` `.css` など）は、**組み立て前のソースがここにありません**。'
    + '作り直さず、必要な箇所だけ慎重に直します。大きく変える話になったら、'
    + 'まず「組み立て前のソースはお持ちですか」と利用者に確かめてください。')

  if (target === 'sakura-apprun') {
    lines.push('- 取り出したのは**組み立てたあとの状態**です（公開されていたイメージの中身）。')
    lines.push('- `node_modules` があれば、それは依存パッケージの実体です。'
      + '**直しても組み立て直しで消える**ので触りません。変えるなら `package.json` と自分のソースです。')
    const keys: string[] = Array.isArray(f.settings?.secretKeys) ? f.settings.secretKeys : []
    if (keys.length) {
      lines.push(`- 秘密の値（${keys.join(', ')}）は**取り戻せていません。手元に値がありません。**`
        + 'これらを使うコードは、このままでは動きません。`.env` を勝手に作らず、'
        + '値が要る場面になったら利用者に伝えてください（公開のときに入れ直します）。')
    }
    const envKeys: string[] = Array.isArray(f.settings?.env)
      ? f.settings.env.map((e: any) => e?.key).filter((k: any) => typeof k === 'string')
      : []
    const spec = [
      typeof f.settings?.port === 'number' ? `ポート ${f.settings.port}` : '',
      envKeys.length ? `環境変数 ${envKeys.join(', ')}（値はここには載せていません）` : '',
    ].filter(Boolean)
    if (spec.length) lines.push(`- 公開されていたときの設定: ${spec.join(' / ')}`)
    if (f.adopted) {
      // ── 引き継ぎずみ（dev-plan ④ 第4段階）────────────────────────────
      // **URL もお金も変わらない代わりに、間違えたときに壊れるのは本物になる。**
      lines.push('- このプロジェクトは、いま動いているアプリを**引き継いでいます**。'
        + 'ここから公開すると、**そのアプリが、このプロジェクトの内容で更新されます**（公開のアドレスは変わりません）。')
      lines.push('- つまり、**公開＝本番の差し替え**です。'
        + '公開を勧めるときは「いま公開中のものが、この内容に置き換わります」と必ず添えてください。')
      lines.push('- 「破棄」は**本物のアプリを消します**。頼まれていないのに勧めないでください。')
    } else {
      // ⚠️ **「できません」と言わない**（2026-08-24 Ryosuke 指摘）。
      // 手を入れて公開すること自体はできる。利用者はそれを「更新している」と受け取ってよい。
      // 内部で別のアプリになるのはシステム側の言い分で、利用者には関係がない。
      // **関係があるのは URL とお金の2つだけ**なので、それを伝える。
      lines.push('- このまま手を入れて公開していけます。ただし公開の前に、**必ず次の2つを伝えてください**。')
      lines.push('  ① **公開のアドレス（URL）が変わります。**'
        + 'いま公開されているアドレスは、古い内容のまま生き続けます。'
        + 'そのアドレスを誰かに伝えているなら、新しいものを伝え直す必要があります。')
      lines.push(`  ② **月額${REGISTRY_MONTHLY_YEN}円（税込）が上乗せ**されます。`
        + 'イメージの置き場（コンテナレジストリ）がもう1つ増えるためです。'
        + '古いほうが要らなくなったら、さくらのクラウドのコントロールパネルで消してください'
        + '（Koto からは消せません）。')
    }
  } else if (intent === 'update') {
    lines.push(`- ここから公開すると、Vercel のプロジェクト「${f.name ?? ''}」が**置き換わります**。`
      + '公開を勧めるときは、そのことを必ず添えてください。')
  } else if (intent === 'fork') {
    lines.push('- ここから公開すると、**別の新しい Vercel プロジェクト**になります。'
      + `いまの「${f.name ?? ''}」はそのまま公開され続けます。`)
  } else {
    lines.push('- 公開先はまだ決まっていません。公開の話になったら、'
      + `いまの「${f.name ?? ''}」を置き換えるのか、別物として出すのかを確かめてください。`)
  }

  lines.push('- 元の作り方（設計の意図・経緯）は残っていません。分からないことは推測で埋めず、利用者に聞いてください。')
  lines.push('- 🕘 履歴に「公開されていたものをインポートした時点」があるので、'
    + '大きく変えても元へ戻せます。思い切った変更を提案してよい場面では、そのことも伝えてください。')
  return lines.join('\n')
}

/**
 * 探しても見つからなかったときの案内（純関数）。
 *
 * ── なぜ要るか（2026-08-24 Ryosuke 指摘）────────────────────────────────
 * インポートは**使用中のキー1つ**でしか探していない。キーを複数持っている人
 * （個人用と仕事用、チームごと）は珍しくないので、「見つかりません」の本当の意味が
 * **「そのキーからは見えません」**であることは多い。
 * 何も言わないと「公開したものが消えた」と誤解させる。
 */
export function noCandidatesHint(target: ImportTarget, keyCount: number): string {
  const head = target === 'vercel'
    ? 'インポートできるものが見つかりませんでした。'
    : 'インポートできるものが見つかりませんでした。'
  if (keyCount > 1) {
    return head + `いま使っているキー以外にも ${keyCount - 1} 個あります。`
      + '別のキーに切り替えると見つかるかもしれません。'
  }
  return head + (target === 'vercel'
    ? 'そのトークンから見える範囲に、公開したものがありません（範囲を絞ったトークンでは見えないことがあります）。'
    : 'このアカウントに AppRun のアプリがありません。')
}


// ── 画面に出すときの強調 ──────────────────────────────────────────────
//
// ⚠️ **`**` がそのまま画面に出ていた**（0.3.41〜。2026-08-25 の実機スクショで判明）。
// ここの文言は素のテキストとして `<p>` に流し込まれるので、Markdown は解釈されない。
//
// 消してしまうのがいちばん簡単だが、それだと**いちばん読ませたい一行**
// （「公開のアドレス（URL）は変わりません」「月額は増えません」）が平坦になる。
// **強調は強調として出す。**

/** 文字列を、太字にするところとしないところへ分ける（純関数）。 */
export type TextSpan = { text: string; bold: boolean }

/**
 * `**…**` を太字の区間として切り出す（純関数）。
 *
 * 閉じていない `**` は**強調にしない**（書き間違いで、文の後ろ全部が太字になるのを防ぐ）。
 */
export function emphasize(text: string): TextSpan[] {
  const parts = String(text ?? '').split('**')
  // 区切りが偶数個＝閉じている。奇数個＝最後が閉じていないので、その手前までを強調とみなす。
  const closed = parts.length % 2 === 1
  const lastBoldIndex = closed ? parts.length - 1 : parts.length - 2
  return parts
    .map((t, i) => ({ text: t, bold: i % 2 === 1 && i <= lastBoldIndex }))
    .filter(sp => sp.text !== '')
}
