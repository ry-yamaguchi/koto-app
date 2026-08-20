// textWrap.ts — チャットの本文に必ず付ける折り返し。
//
// ── なぜ一元化するか（2026-08-19 実機・Ryosuke 指摘）────────────────────
// 「チャット欄の文字が欄から溢れている」
//
// 本文は `whitespace-pre-wrap` だけを付けていた。これは**空白では折り返すが、
// 区切りの無い長い文字列は折り返さない**。AI が
// `images/Gemini_Generated_Image_zhc59fzhc59fzhc5.jpeg` のような名前を書くと、
// 吹き出しの幅を突き抜けて欄からはみ出した。
//
// 付け忘れた場所だけが溢れるので、**文字列をここに1つ置いて全部が使う**（掟10）。
//
//   ・whitespace-pre-wrap … AI の改行をそのまま見せる
//   ・break-words         … 長い単語を端で折る
//   ・overflow-wrap:anywhere … 区切りの無い文字列も折る（URL・長いファイル名）

/** チャットの本文（利用者の発言・AIの回答・思考）に付ける。 */
export const CHAT_TEXT_WRAP = 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
