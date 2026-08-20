import React, { useState, useCallback, useEffect, useRef } from 'react'
import SakuraLogo from './SakuraLogo'
import { getDefaultModel, setDefaultModel } from '../usage'
import { isAvailableTarget, getTargetProfile, type TargetId } from '../targetProfiles'
import { beginActivity } from '../activity'
import { useModels } from '../hooks/useModels'
import { useClaudeModels } from '../hooks/useClaudeModels'
import ModelSelect from './ModelSelect'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, getClaudeModel, setClaudeMode, setClaudeModel } from '../claudeMode'
import { defaultCreationBrain, pickSavedModel, type CreationBrain } from '../newProjectAgent'
import { buildNewProjectRequest, stashNewProjectRequest, SITE_TYPES } from '../newProjectRequest'

const WORKSPACE_KEY = 'sakura_workspace'
const WORKSPACE_DIRNAME = 'SAKURAIDE'
// 「このあとチャットで作業するAI」の選択（作成実行時に一度だけ、実際のチャットの頭脳・モデルへ反映する。
// 詳しくは runCreate 内のコメント参照）。選んだ内容は次回の初期値として localStorage に覚えておく。
const NEWPROJECT_AGENT_KEY = 'sakura_newproject_agent'
const NEWPROJECT_MODEL_SAKURA_KEY = 'sakura_newproject_model_sakura'
const NEWPROJECT_MODEL_CLAUDE_KEY = 'sakura_newproject_model_claude'

// プロジェクト名に使える文字（半角英数字・ハイフン・アンダースコア・ドット）
const NAME_OK = /^[A-Za-z0-9._-]+$/

interface Props {
  apiKey: string
  onClose: () => void
  onCreated: (rootDir: string, openRelPath?: string) => void
}

interface GenFile { path: string; content: string }

const TEMPLATES = [
  { id: 'blank', label: '空', hint: '最小構成（README のみ）' },
  { id: 'web', label: 'Web', hint: 'HTML / CSS / JS の静的サイト' },
  { id: 'react', label: 'React', hint: 'Vite + React + TypeScript' },
  { id: 'python', label: 'Python', hint: 'main.py + requirements.txt' },
  { id: 'node', label: 'Node API', hint: 'Express の REST API' },
]

// 「何を作るか」：Webサイト（静的サイト中心）／アプリ（ツール・API等）／まっさら（空で始める）
type KindId = 'site' | 'app' | 'blank'
const KINDS: { id: KindId; label: string; hint: string }[] = [
  { id: 'site', label: '🌐 Webサイト', hint: 'ホームページ・LP・お店/会社の紹介' },
  { id: 'app', label: '⚙️ アプリ', hint: '動きのあるツール・Webアプリ・API' },
  // まっさら: ファイルを一切生成しない。決めてから作りたい人向け（ユーザー要望 2026-07-23）。
  { id: 'blank', label: '📄 まっさら', hint: '空で始める。あとからチャットでAIに頼んで作れます' },
]

// SITE_TYPES（サイトの種類）は newProjectRequest.ts へ一本化（依頼文の組み立てと表示の両方で使うため）。

// 公開先の選択肢。準備中の target（VPS/クラウド）は targetProfiles.isAvailableTarget で除外して表示しない。
// group で「さくらインターネットのサービス」と「さくら以外」に分けて表示する（③公開ダイアログと同じ方針）。
const TARGETS: { id: TargetId; label: string; hint: string; group: 'sakura' | 'other' }[] = [
  { id: 'local', label: 'あとで決める（おすすめ）', hint: 'まずは手元で作って試せます。公開先はあとから選べます（おすすめ）', group: 'sakura' },
  { id: 'sakura-rental', label: 'さくらのレンタルサーバ', hint: 'ホームページ向け。さくらのレンタルサーバで公開', group: 'sakura' },
  { id: 'sakura-apprun', label: 'さくらのAppRun', hint: 'プログラムが動くアプリ向け。さくらのAppRunで公開', group: 'sakura' },
  { id: 'sakura-vps', label: 'さくらのVPS', hint: '上級者向け。サーバ内で完結する構成', group: 'sakura' },
  { id: 'sakura-cloud', label: 'さくらのクラウド', hint: '上級者向け。クラウドサービス前提', group: 'sakura' },
  { id: 'hanamii', label: 'HANAMII（国産PaaS）', hint: 'さくらのクラウド基盤の国産PaaS。サイトもアプリも公開可', group: 'other' },
  { id: 'vercel', label: 'Vercel（海外）', hint: '静的サイト/フロントエンド向けの海外PaaS。データは国外', group: 'other' },
]

// 公開先のグループ表示順とタイトル（PublishModal と同じ文言）
const TARGET_GROUPS: { key: 'sakura' | 'other'; title: string }[] = [
  { key: 'sakura', title: 'さくらインターネットのサービス' },
  { key: 'other', title: 'さくら以外の公開先' },
]

/** 「ベース」指定を無視して専用構成で生成する公開先 */
const FIXED_STACK_TARGETS: TargetId[] = ['sakura-rental', 'sakura-apprun']

/** Minimal local scaffold per base — used as a fallback when no API key is registered. */
function localTemplate(base: string, name: string, description: string): GenFile[] {
  const desc = description.trim()
  const readme = (body: string): GenFile => ({
    path: 'README.md',
    content: `# ${name}\n\n${desc || '（説明未記入）'}\n\n${body}\n`,
  })

  switch (base) {
    case 'web':
      return [
        { path: 'index.html', content: `<!DOCTYPE html>\n<html lang="ja">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <h1>${name}</h1>\n  <p id="app">Hello, world!</p>\n  <script src="script.js"></script>\n</body>\n</html>\n` },
        { path: 'style.css', content: `body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.6; }\nh1 { color: #ff5577; }\n` },
        { path: 'script.js', content: `console.log('${name} started');\n` },
        readme('## 使い方\n\n`index.html` をブラウザで開いてください。'),
      ]
    case 'python':
      return [
        { path: 'main.py', content: `def main():\n    print("Hello from ${name}")\n\n\nif __name__ == "__main__":\n    main()\n` },
        { path: 'requirements.txt', content: `` },
        readme('## 使い方\n\n```bash\npython main.py\n```'),
      ]
    case 'react':
      return [
        { path: 'package.json', content: `{\n  "name": "${name}",\n  "private": true,\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "react": "^18.3.0",\n    "react-dom": "^18.3.0"\n  },\n  "devDependencies": {\n    "@vitejs/plugin-react": "^4.3.0",\n    "vite": "^5.4.0"\n  }\n}\n` },
        { path: 'index.html', content: `<!DOCTYPE html>\n<html lang="ja">\n<head><meta charset="UTF-8" /><title>${name}</title></head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n` },
        { path: 'src/main.jsx', content: `import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n` },
        { path: 'src/App.jsx', content: `export default function App() {\n  return <h1>${name}</h1>\n}\n` },
        readme('## 使い方\n\n```bash\nnpm install\nnpm run dev\n```'),
      ]
    case 'node':
      return [
        { path: 'package.json', content: `{\n  "name": "${name}",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "start": "node index.js" },\n  "dependencies": { "express": "^4.19.0" }\n}\n` },
        { path: 'index.js', content: `import express from 'express'\n\nconst app = express()\napp.get('/', (req, res) => res.json({ message: 'Hello from ${name}' }))\napp.listen(3000, () => console.log('http://localhost:3000'))\n` },
        readme('## 使い方\n\n```bash\nnpm install\nnpm start\n```'),
      ]
    default: // blank
      return [readme('')]
  }
}

/** APIキー未登録のため、ローカル雛形のみで作成したことを伝える案内ファイル。
 *  以前は「AI応答を解析できなかった」「AI呼び出し自体が失敗した」場合の案内も兼ねていたが、
 *  雛形生成をチャット方式へ全面切替した現在は、モーダル内でAIを呼ぶこと自体が無くなった
 *  （＝解析失敗・呼び出し失敗というケースが発生しなくなった）ため、この2分岐は削除し
 *  「キー未登録」の案内だけを残す。 */
function guideFile(name: string): GenFile {
  return {
    path: 'はじめにお読みください.md',
    content:
      `# ${name} へようこそ 🌸\n\n` +
      `## 現在の状態\n\n` +
      `さくらのAI Engine または Claude の **APIキーが未設定** のため、AIへの接続を行っていません。\n\n` +
      `そのため、**AIによるアプリ開発・詳細なフォルダ構成の生成は行っていません。**\n` +
      `現在あるのは、選択したベースの**最小限の雛形ファイル**のみです。\n\n` +
      `## 次のステップ\n\n` +
      `1. **APIキーを登録する**\n` +
      `   - 画面右上の「チャット」または「AI」パネルの設定（⚙️）から、さくらのAI Engine または Claude のAPIキーを入力\n` +
      `   - さくらのAI Engineのキーは [さくらのAI Engine](https://ai.sakura.ad.jp/) で取得できます\n` +
      `   - Claudeのキーは [Anthropic Console](https://console.anthropic.com/) で取得できます\n` +
      `2. **AIに開発を依頼する**\n` +
      `   - キー登録後、チャットで「このプロジェクトに〇〇を実装して」と依頼するとコードを生成します\n` +
      `3. もう一度「新規プロジェクト」から作り直すこともできます\n\n` +
      `---\n*このファイルは削除して構いません。*\n`,
  }
}

/* ============================================================
 * さくらのレンタルサーバ向けテンプレート（PHP + MySQL + 公開設定）
 * 公開ディレクトリ public/ を ~/www へ、非公開 app/ を ~/app へ rsync で配置する構成。
 * ========================================================== */
function rentalServerFiles(name: string, desc: string): GenFile[] {
  const indexPhp =
`<?php
require_once __DIR__ . '/../app/db.php';

$phpVersion = phpversion();
$dbStatus = '未接続（app/config.php を作成してください）';
try {
    if (function_exists('db')) {
        db()->query('SELECT 1');
        $dbStatus = '接続OK';
    }
} catch (Throwable $e) {
    $dbStatus = '接続エラー: ' . htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <main class="card">
    <h1>${name} 🌸</h1>
    <p>さくらのレンタルサーバで動作しています。</p>
    <dl>
      <dt>PHP バージョン</dt><dd><?= htmlspecialchars($phpVersion, ENT_QUOTES, 'UTF-8') ?></dd>
      <dt>データベース</dt><dd><?= $dbStatus ?></dd>
    </dl>
    <p class="hint">このページは <code>public/index.php</code> です。ここから開発を始めましょう。</p>
  </main>
</body>
</html>
`

  const htaccess =
`# さくらのレンタルサーバ向け Apache 設定
RewriteEngine On

# HTTPS へリダイレクト（共有SSL / 独自SSL 利用時）
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]

DirectoryIndex index.php index.html
AddDefaultCharset UTF-8

# 静的ファイルのキャッシュ
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/css "access plus 7 days"
  ExpiresByType application/javascript "access plus 7 days"
  ExpiresByType image/png "access plus 30 days"
  ExpiresByType image/jpeg "access plus 30 days"
  ExpiresByType image/svg+xml "access plus 30 days"
</IfModule>

# 隠しファイルへのアクセス禁止
<FilesMatch "^\\.">
  Require all denied
</FilesMatch>
`

  const userIni =
`; さくらのレンタルサーバ PHP 設定（.user.ini）
date.timezone = "Asia/Tokyo"
mbstring.internal_encoding = "UTF-8"
upload_max_filesize = "16M"
post_max_size = "16M"
memory_limit = "128M"
display_errors = "Off"
`

  const styleCss =
`:root { --sakura: #ff5577; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: "游ゴシック", "Yu Gothic", system-ui, sans-serif;
  background: #fff6f8; color: #404044;
}
.card {
  background: #fff; padding: 2.5rem 3rem; border-radius: 16px;
  box-shadow: 0 10px 40px rgba(255,85,119,.12); max-width: 520px;
}
h1 { color: var(--sakura); margin-top: 0; }
dl { display: grid; grid-template-columns: auto 1fr; gap: .4rem 1rem; }
dt { color: #7e7e86; }
code { background: #fff6f8; padding: .1em .4em; border-radius: 4px; }
.hint { color: #7e7e86; font-size: .9rem; }
`

  const dbPhp =
`<?php
// MySQL(PDO) 接続ヘルパー。接続情報は app/config.php に記述します（config.sample.php 参照）。
function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $configPath = __DIR__ . '/config.php';
    if (!file_exists($configPath)) {
        throw new RuntimeException('app/config.php がありません。config.sample.php をコピーして作成してください。');
    }
    $config = require $configPath;
    $dsn = 'mysql:host=' . $config['host'] . ';dbname=' . $config['dbname'] . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $config['user'], $config['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}
`

  const configSample =
`<?php
// このファイルを config.php としてコピーし、さくらのMySQL情報を入力してください。
// 情報は コントロールパネル → データベース で確認できます。
return [
    'host'   => 'mysqlXXX.db.sakura.ne.jp', // 例: mysql3107.db.sakura.ne.jp
    'dbname' => 'youraccount_dbname',
    'user'   => 'youraccount',
    'pass'   => 'your_password',
];
`

  const deploySh =
`#!/usr/bin/env bash
# さくらのレンタルサーバ デプロイスクリプト（rsync over SSH）
# 1) 下の ACCOUNT を初期ドメインのアカウント名に変更
# 2) SSHが使えること（スタンダードプラン以上）を確認
# 3) ./deploy.sh を実行
set -euo pipefail

ACCOUNT="your-account"                  # 例: taro （初期ドメイン taro.sakura.ne.jp）
SSH_HOST="\${ACCOUNT}.sakura.ne.jp"
WWW="/home/\${ACCOUNT}/www"              # 公開ディレクトリ
APPDIR="/home/\${ACCOUNT}/app"           # 非公開（DB設定など）

echo "==> public/ を \${WWW} へ同期"
rsync -avz --exclude='.DS_Store' public/ "\${ACCOUNT}@\${SSH_HOST}:\${WWW}/"

echo "==> app/ を \${APPDIR} へ同期（雛形 config.sample.php は除外）"
rsync -avz --exclude='config.sample.php' --exclude='.DS_Store' app/ "\${ACCOUNT}@\${SSH_HOST}:\${APPDIR}/"

echo "==> 公開完了: https://\${SSH_HOST}/"
`

  const gitignore =
`# 機密情報（サーバには deploy.sh 経由でアップロード）
app/config.php

# OS
.DS_Store
`

  const readme =
`# ${name}

${desc || '（説明未記入）'}

さくらのレンタルサーバで公開する前提のプロジェクトです（PHP + MySQL）。

## フォルダ構成

\`\`\`
${name}/
├── public/            # 公開ディレクトリ（サーバの ~/www に配置）
│   ├── index.php
│   ├── .htaccess      # HTTPS強制・キャッシュ等
│   ├── .user.ini      # PHP設定
│   └── assets/style.css
├── app/               # 非公開（サーバの ~/app に配置）
│   ├── db.php         # MySQL(PDO) 接続
│   └── config.sample.php
├── deploy.sh          # rsync で公開
└── .gitignore
\`\`\`

## 公開手順

1. **さくらのレンタルサーバを契約**（SSH・MySQLが使える *スタンダード* 以上を推奨）
2. **MySQLデータベースを作成**：コントロールパネル → データベース
3. **接続情報を設定**：\`app/config.sample.php\` を \`app/config.php\` にコピーし、MySQL情報を入力
   （\`config.php\` は \`.gitignore\` 済み。サーバへは deploy.sh が安全にアップロードします）
4. **SSHの準備**：コントロールパネルでSSHを有効化（鍵 or パスワード）
5. **デプロイ**：\`deploy.sh\` の \`ACCOUNT\` を自分のアカウント名に変更して実行
   \`\`\`bash
   ./deploy.sh
   \`\`\`
6. **アクセス**：\`https://<アカウント>.sakura.ne.jp/\`
7. **独自ドメイン + 無料SSL（Let's Encrypt）** はコントロールパネルから設定できます

## ローカルで確認

PHPが入っていれば、組み込みサーバで確認できます：

\`\`\`bash
php -S localhost:8000 -t public
\`\`\`

## 活用できるレンタルサーバの機能

- PHP 8系 / MySQL / Apache(.htaccess)
- cron（定期実行）／メール送信
- 共有SSL・独自SSL（無料）／独自ドメイン
`

  return [
    { path: 'public/index.php', content: indexPhp },
    { path: 'public/.htaccess', content: htaccess },
    { path: 'public/.user.ini', content: userIni },
    { path: 'public/assets/style.css', content: styleCss },
    { path: 'app/db.php', content: dbPhp },
    { path: 'app/config.sample.php', content: configSample },
    { path: 'deploy.sh', content: deploySh },
    { path: '.gitignore', content: gitignore },
    { path: 'README.md', content: readme },
  ]
}

/* ============================================================
 * さくらのAppRun 向けテンプレート（Docker コンテナ）
 * コンテナをビルド → さくらのコンテナレジストリ(*.sakuracr.jp)へ push →
 * AppRun でイメージを指定して起動する構成。ポートは 8080。
 * ========================================================== */
function appRunFiles(name: string, desc: string): GenFile[] {
  const serverJs =
`const http = require('http')

const PORT = process.env.PORT || 8080

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(\`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${name}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fff6f8;color:#404044}
.card{background:#fff;padding:2.5rem 3rem;border-radius:16px;box-shadow:0 10px 40px rgba(255,85,119,.12)}
h1{color:#ff5577;margin-top:0}</style></head>
<body><div class="card"><h1>${name} 🌸</h1>
<p>さくらのAppRun でコンテナが動作しています。</p>
<p>Port: \${PORT}</p></div></body></html>\`)
})

server.listen(PORT, () => console.log(\`listening on port \${PORT}\`))
`

  const packageJson =
`{
  "name": "${name}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
`

  const dockerfile =
`# さくらのAppRun は x86_64(linux/amd64) で動作します
FROM node:20-slim
WORKDIR /app

# 依存があれば先にインストール（キャッシュ活用）
COPY package*.json ./
RUN npm install --omit=dev || true

COPY . .

# AppRun の待ち受けポート
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
`

  const dockerignore =
`node_modules
npm-debug.log
.git
.gitignore
.DS_Store
README.md
`

  const gitignore =
`node_modules/
npm-debug.log
.DS_Store
.env
`

  const readme =
`# ${name}

${desc || '（説明未記入）'}

さくらのAppRun（コンテナをサーバレス実行）で公開する前提のプロジェクトです。

## 構成

\`\`\`
${name}/
├── server.js       # Node.js HTTPサーバ（PORT=8080 で待ち受け）
├── package.json
├── Dockerfile      # linux/amd64 でビルド
└── .dockerignore
\`\`\`

## ローカルで確認

\`\`\`bash
node server.js        # http://localhost:8080
# または Docker で
docker build --platform linux/amd64 -t ${name} .
docker run -p 8080:8080 ${name}
\`\`\`

## 公開手順（さくらのAppRun）

このプロジェクトは **IDE の【③ 公開】→「さくらのAppRun」** からそのまま公開できます。
Docker のインストールやコントロールパネルでの操作は不要です。IDE が自動で
コンテナをビルドし、コンテナレジストリの作成・イメージの登録・アプリの作成・
公開URLの発行まで行います（ポートは 8080）。

1. 画面上部の【③ 公開】を開く
2. 公開先で「さくらのAppRun」を選ぶ
3. 「構築する」を押す（プランを確認 → 実行）。完了すると公開URLが表示されます

## メモ
- AppRun は x86_64 なので、必ず \`--platform linux/amd64\` でビルドします（Apple Silicon でも同様）。
- \`/healthz\` でヘルスチェック用の応答を返します。
`

  return [
    { path: 'server.js', content: serverJs },
    { path: 'package.json', content: packageJson },
    { path: 'Dockerfile', content: dockerfile },
    { path: '.dockerignore', content: dockerignore },
    { path: '.gitignore', content: gitignore },
    { path: 'README.md', content: readme },
  ]
}

/** A short note for targets whose full scaffolding is not implemented yet. */
function deployNote(target: TargetId, name: string): GenFile {
  const body =
    target === 'sakura-vps'
      ? `## デプロイ: さくらのVPS\n\nVPS向けの完全な構成は今後のアップデートで追加予定です。\n\n**想定する構成（VPS内で完結）**\n- Webサーバ（nginx / Apache）＋アプリ＋DBを同一VPSに構築\n- systemd でアプリを常駐\n- ファイアウォール / SSH 公開鍵でアクセス制御\n`
      : `## デプロイ: さくらのクラウド\n\nクラウド向けの完全な構成は今後のアップデートで追加予定です。\n\n**検討するさくらのクラウドサービス例**\n- サーバ / ロードバランサ / データベースアプライアンス\n- オブジェクトストレージ / DNS\n- スタートアップスクリプトでの自動構築\n`
  return { path: 'DEPLOY.md', content: `# ${name} デプロイ構成\n\n${body}` }
}

/** Build the local scaffold for a given deploy target (used without AI, or as fallback). */
function buildLocalFiles(target: TargetId, base: string, name: string, desc: string): GenFile[] {
  if (target === 'sakura-rental') return rentalServerFiles(name, desc)
  if (target === 'sakura-apprun') return appRunFiles(name, desc)
  const files = localTemplate(base, name, desc)
  if (target === 'sakura-vps' || target === 'sakura-cloud') files.push(deployNote(target, name))
  return files
}

/** Webサイト用のローカル雛形（AI未使用時のフォールバック）。 */
function siteLocalTemplate(siteType: string, name: string, desc: string): GenFile[] {
  const title = name
  const tagline = desc.trim() || 'ようこそ。このサイトは Koto で作成されました。'
  const nav = (active: string) => {
    const items: [string, string][] = [['index.html', 'ホーム'], ['about.html', '紹介'], ['contact.html', 'お問い合わせ']]
    return `<nav><a href="index.html" class="brand">${title}</a><div>` +
      items.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`).join('') +
      `</div></nav>`
  }
  const page = (file: string, heading: string, body: string) =>
`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${heading} | ${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${nav(file)}
<main>
<h1>${heading}</h1>
${body}
</main>
<footer>© ${title}</footer>
</body>
</html>
`
  const css =
`/* ${title} の共通スタイル（スマホ対応） */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; color: #333; line-height: 1.8; }
nav { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid #eee; flex-wrap: wrap; gap: 8px; }
nav .brand { font-weight: bold; font-size: 1.1rem; color: #e0245e; text-decoration: none; }
nav a { color: #555; text-decoration: none; margin-left: 16px; }
nav a.active { color: #e0245e; font-weight: bold; }
main { max-width: 800px; margin: 0 auto; padding: 48px 20px; }
h1 { font-size: 1.6rem; margin-bottom: 20px; }
footer { text-align: center; padding: 24px; color: #999; border-top: 1px solid #eee; margin-top: 48px; font-size: 0.85rem; }
@media (max-width: 600px) { main { padding: 32px 16px; } }
`
  const readme: GenFile = {
    path: 'README.md',
    content: `# ${title}\n\n${tagline}\n\n静的なWebサイトです。上部の【② 試す】でブラウザ確認、【③ 公開】でさくらのレンタルサーバ等へ公開できます。\n`,
  }
  if (siteType === 'lp') {
    return [
      { path: 'index.html', content: page('index.html', title, `<p>${tagline}</p>\n<p>ここに商品・サービスの特徴を書きます。AIチャットに「キャッチコピーを考えて」「特徴を3つのカードで見せて」のように頼むと作り込めます。</p>`) },
      { path: 'style.css', content: css },
      readme,
    ]
  }
  return [
    { path: 'index.html', content: page('index.html', title, `<p>${tagline}</p>`) },
    { path: 'about.html', content: page('about.html', '紹介', `<p>ここに${siteType === 'portfolio' ? '作品・実績' : siteType === 'blog' ? '記事の一覧' : '会社・お店の紹介'}を書きます。</p>`) },
    { path: 'contact.html', content: page('contact.html', 'お問い合わせ', `<p>メール: <a href="mailto:info@example.com">info@example.com</a></p>`) },
    { path: 'style.css', content: css },
    readme,
  ]
}

// sitePrompt/targetPrompt（公開先ごとの構成指示）と雛形生成プロンプトの組み立ては
// newProjectRequest.ts の buildNewProjectRequest() へ移設した（チャット方式への全面切替・2026-07-31）。
// モーダル側はプロジェクト作成後にその依頼文をチャットへ渡すだけになり、AI応答の解析（旧 extractJson/toFiles）も
// 不要になった。

export default function NewProjectModal({ apiKey, onClose, onCreated }: Props) {
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<KindId>('site')
  const [siteType, setSiteType] = useState('lp')
  const [template, setTemplate] = useState('blank')
  const [target, setTarget] = useState<TargetId>('local')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<{ path: string; suggestion: string } | null>(null)

  // ── 「このあとチャットで作業するAI」（頭脳＋モデル）。選択中はこの画面内だけの状態だが、
  //    作成を実行した瞬間（runCreate）に setClaudeMode/setClaudeModel/setDefaultModel でアプリ全体の
  //    頭脳・既定モデル設定へ反映する（この後チャットが実際に作業を引き継ぐため）。
  //    選んだ内容は localStorage にも覚えて次回この画面を開いたときの初期値にする。
  const [claudeKey, setClaudeKey] = useState('')
  const sakuraModels = useModels(apiKey)
  const claudeModels = useClaudeModels(claudeKey)
  // brain: 両方/片方のキーの有無から初期値を決める（defaultCreationBrain）。Claudeキーの取得は非同期
  // なので、まずさくらキーだけで暫定判定し（同期・ちらつき防止）、取得後に一度だけ確定させる。
  const [brain, setBrain] = useState<CreationBrain | null>(() =>
    defaultCreationBrain({
      hasSakuraKey: !!apiKey,
      hasClaudeKey: false,
      claudeModeOn: isClaudeModeEnabled(),
      saved: localStorage.getItem(NEWPROJECT_AGENT_KEY),
    })
  )
  const brainInitRef = useRef(false)
  const [sakuraModelId, setSakuraModelId] = useState(() =>
    pickSavedModel(localStorage.getItem(NEWPROJECT_MODEL_SAKURA_KEY), sakuraModels.map(m => m.id), getDefaultModel('ide'))
  )
  const [claudeModelId, setClaudeModelId] = useState(() =>
    pickSavedModel(localStorage.getItem(NEWPROJECT_MODEL_CLAUDE_KEY), claudeModels.map(m => m.id), getClaudeModel())
  )

  // Claudeキーを読み込み、担当AIの初期値を確定させる（初回のみ。以降はユーザーの選択を尊重する）。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const key = await getAnthropicToken()
      if (cancelled) return
      setClaudeKey(key ?? '')
      if (!brainInitRef.current) {
        brainInitRef.current = true
        setBrain(defaultCreationBrain({
          hasSakuraKey: !!apiKey,
          hasClaudeKey: !!key,
          claudeModeOn: isClaudeModeEnabled(),
          saved: localStorage.getItem(NEWPROJECT_AGENT_KEY),
        }))
      }
    })()
    return () => { cancelled = true }
  }, [apiKey])

  // モデル一覧のライブ取得完了後、選択中のIDが提供終了などで一覧に無ければ有効なIDへ差し替える
  // （ChatPanel.tsx の自己修復ロジックと同じ考え方）。
  useEffect(() => {
    if (!sakuraModels.length) return
    if (sakuraModels.some(m => m.id === sakuraModelId)) return
    setSakuraModelId(pickSavedModel(null, sakuraModels.map(m => m.id), getDefaultModel('ide')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sakuraModels])
  useEffect(() => {
    if (!claudeModels.length) return
    if (claudeModels.some(m => m.id === claudeModelId)) return
    setClaudeModelId(pickSavedModel(null, claudeModels.map(m => m.id), getClaudeModel()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeModels])

  // 担当AIの選択を変更する（唯一の書き込み口。次回の初期値として localStorage に覚える）。
  const chooseBrain = (b: CreationBrain) => {
    setBrain(b)
    localStorage.setItem(NEWPROJECT_AGENT_KEY, b)
  }

  // Initialise the location to the app workspace root (default: ~/SakuraIDE),
  // or the last-used workspace if the user changed it before.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const saved = localStorage.getItem(WORKSPACE_KEY)
      if (saved) {
        if (!cancelled) setParentDir(saved)
        return
      }
      const home = await window.electronAPI.fs.homeDir()
      if (!cancelled) setParentDir(`${home}/${WORKSPACE_DIRNAME}`)
    })()
    return () => { cancelled = true }
  }, [])

  const pickDir = async () => {
    const dir = await window.electronAPI.fs.pickDirectory()
    if (dir) {
      setParentDir(dir)
      localStorage.setItem(WORKSPACE_KEY, dir) // remember as the default workspace
      setConflict(null)
    }
  }

  // The actual creation + write. allowExisting=true merges into an existing folder.
  //
  // AI生成をチャット方式へ全面切替（2026-07-31）: 以前はここで さくらのAI Engine / Claude に
  // 一問一答（さくらは sakura.chat、Claudeは main側の一問一答専用IPC）で雛形生成を依頼していた
  // （両経路とも削除済み）。今はキーがあれば .sakuraide.json だけの空プロジェクトを作り、実際のファイル生成は
  // sakura-new-project-request イベントで IDE のチャットへ依頼する（ChatPanel.tsx が購読）。
  // 狙い: モーダルで待たない・失敗時に「やり直して」「続けて」と言い直せる・1回の応答に
  // 全ファイルを詰め込む必要がなくなる（出力上限で切れる事故を防ぐ）・ツール非対応モデルの
  // 自動切替などチャット経路の既存機能が効く・雛形生成の経路が1本になる（詳細は
  // newProjectRequest.ts 冒頭コメント参照）。
  const runCreate = useCallback(async (projName: string, allowExisting: boolean) => {
    setError('')
    setConflict(null)
    const n = projName.trim()
    if (!parentDir) { setError('ワークスペースが未設定です'); return }
    if (!n) { setError('プロジェクト名を入力してください'); return }
    if (!NAME_OK.test(n)) {
      setError('プロジェクト名は半角英数字・ハイフン(-)・アンダースコア(_)・ドット(.)のみ使用できます')
      return
    }

    setBusy(true)
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('プロジェクトの作成')
    try {
      const targetPath = `${parentDir}/${n}`

      // Duplicate check: ask the user to pick a different name (auto-suggest a free one).
      if (!allowExisting && (await window.electronAPI.fs.exists(targetPath))) {
        let i = 2
        let suggestion = `${n}-${i}`
        while (await window.electronAPI.fs.exists(`${parentDir}/${suggestion}`)) {
          i++
          suggestion = `${n}-${i}`
        }
        setConflict({ path: targetPath, suggestion })
        setBusy(false)
        return
      }

      // チャットに作成を依頼できるか＝選ばれた頭脳のキーがあるか（さくら固定ではない）。
      // brain が null（両方のキーとも未登録）のときは false になり、下のローカル雛形分岐へ落ちる。
      const useChat = kind !== 'blank' && (brain === 'claude' ? !!claudeKey : brain === 'sakura' ? !!apiKey : false)

      let files: GenFile[]
      if (kind === 'blank') {
        // まっさら: ファイルを一切生成しない（下の隠しメタだけ付与）。依頼も送らない。
        files = []
      } else if (useChat) {
        // 実際のファイルはこの後チャットへ依頼する。ここでは書き込まない（下の .sakuraide.json のみ）。
        files = []
      } else {
        // どちらのキーも無い: 従来どおりローカル雛形＋案内ファイル（はじめにお読みください.md）のみで作成する。
        files = (kind === 'site' ? siteLocalTemplate(siteType, n, description) : buildLocalFiles(target, template, n, description))
        files.push(guideFile(n))
      }

      // 開くファイル: チャットに依頼する場合はまだ何もできていないので開かない
      // （新規作成直後にチャットで作業する様子を見てもらう）。ローカル雛形のみのときは、
      // 専用テンプレート（レンタルサーバ/AppRun）に付属のREADME.mdか、それ以外は案内ファイルを開く。
      let openRelPath: string | undefined =
        kind === 'blank' || useChat ? undefined
          : target !== 'local' ? 'README.md' : 'はじめにお読みください.md'

      // プロジェクトメタ（AIへの文脈付与に使う・ツリーには出ない隠しファイル）
      files.push({
        path: '.sakuraide.json',
        content: JSON.stringify(
          {
            name: n,
            description: description.trim(),
            kind,
            ...(kind === 'site' ? { siteType } : kind === 'app' ? { base: template } : {}),
            target,
            createdAt: new Date().toISOString(),
          },
          null, 2,
        ),
      })

      setStatus(`${files.length} 個のファイルを書き込んでいます...`)
      const result = await window.electronAPI.fs.createProject(parentDir, n, files, allowExisting)

      // If we merged and the file we wanted to open was skipped (already existed), just open the folder.
      if (result.merged && openRelPath && result.skipped.includes(openRelPath)) {
        openRelPath = undefined
      }

      if (useChat) {
        // 「作成を担当するAI」の選択を、この後チャットが実際の作業に使う頭脳・モデルへ反映する
        // （書き込み口は claudeMode.ts / usage.ts の関数のみ＝掟7。ChatPanel 自身の state はここでは触らない）。
        if (brain === 'claude') {
          setClaudeMode(true)
          setClaudeModel(claudeModelId)
        } else {
          setClaudeMode(false)
          setDefaultModel(sakuraModelId, 'ide')
        }
      }

      onCreated(result.root, openRelPath)

      if (useChat) {
        const prompt = buildNewProjectRequest({
          kind,
          name: n,
          siteType: kind === 'site' ? siteType : undefined,
          templateLabel: kind === 'app' ? TEMPLATES.find(t => t.id === template)?.label : undefined,
          templateHint: kind === 'app' ? TEMPLATES.find(t => t.id === template)?.hint : undefined,
          target,
          description,
        })
        if (prompt) {
          // 初めてのプロジェクト作成では、この時点でまだ ChatPanel がマウントされていない
          // （IDEモード表示は mode==='ide' && currentDir が条件のため）。CustomEvent はその場合
          // 受け手不在で失われるので、モジュールスコープにも退避しておき、ChatPanel が後から
          // マウントされたタイミングで拾い直せるようにする（newProjectRequest.ts 参照）。
          stashNewProjectRequest(result.root, prompt)
          // ChatPanel.tsx の sakura-target-changed ハンドラと同じ作法（自動送信でもユーザーが打ったのと
          // 同じ扱いでチャット欄に見える＝透明性）。projectDir の切替がまだ追いついていない場合は
          // ChatPanel 側で dir が一致するまで保留してから送る。
          window.dispatchEvent(new CustomEvent('sakura-new-project-request', { detail: { dir: result.root, prompt } }))
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setBusy(false)
    } finally {
      endActivity()
    }
  }, [parentDir, template, target, description, apiKey, onCreated, kind, siteType, brain, claudeKey, sakuraModelId, claudeModelId])

  const create = useCallback(() => runCreate(name, false), [runCreate, name])

  // Apply the suggested non-colliding name and create immediately.
  const createWithSuggestion = (suggestion: string) => {
    setName(suggestion)
    runCreate(suggestion, false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-[480px] max-h-[90vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4">
          <SakuraLogo size={26} />
          <div>
            <h2 className="text-lg font-bold text-ink">新規プロジェクト</h2>
            <p className="text-xs text-ink-secondary">
              {apiKey || claudeKey ? '作成後、チャットでAIが初期ファイルを作ります' : 'フォルダと雛形を作成します'}
            </p>
          </div>
          {!busy && (
            <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
          )}
        </div>

        <div className="px-6 pb-6 space-y-4">
          {/* Location (workspace root) */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-ink-secondary">ワークスペース</label>
              <button
                onClick={pickDir}
                disabled={busy}
                className="text-[11px] text-sakura hover:underline disabled:opacity-50"
              >
                変更
              </button>
            </div>
            <div className="mt-1.5 w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-surface border border-line text-left text-sm">
              <span>📂</span>
              <span className={`truncate ${parentDir ? 'text-ink' : 'text-ink-muted'}`}>
                {parentDir ?? '読み込み中...'}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">プロジェクトはこのフォルダの配下に作成されます</p>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">プロジェクト名（半角英数字。例: my-shop）</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setConflict(null) }}
              disabled={busy}
              placeholder="my-app"
              className={`mt-1.5 w-full bg-surface border rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none transition-colors disabled:opacity-50 ${
                name.trim() && !NAME_OK.test(name.trim()) ? 'border-brand-red focus:border-brand-red' : 'border-line focus:border-sakura'
              }`}
            />
            {name.trim() && !NAME_OK.test(name.trim()) ? (
              <p className="mt-1 text-[11px] text-brand-red">
                ⚠️ 半角英数字・ハイフン(-)・アンダースコア(_)・ドット(.)のみ使用できます（日本語・スペースは不可）
              </p>
            ) : (
              parentDir && name.trim() && (
                <p className="mt-1 text-[11px] text-ink-muted truncate">作成先: {parentDir}/{name.trim()}</p>
              )
            )}
            <p className="mt-1 text-[11px] text-ink-muted">
              ※ プロジェクト名は<b className="text-ink-secondary">後から変更できません</b>。公開時の名前（URL等に使われる名前）は、公開のときに別途変更できます。
            </p>
          </div>

          {/* 何を作るか（Webサイト / アプリ） */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">何を作りますか？</label>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {KINDS.map(k => (
                <button
                  key={k.id}
                  onClick={() => setKind(k.id)}
                  disabled={busy}
                  className={`px-3 py-2.5 rounded-lg text-left border transition-colors disabled:opacity-50 ${
                    kind === k.id
                      ? 'sakura-gradient text-white border-transparent'
                      : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                  }`}
                >
                  <div className="text-sm font-semibold">{k.label}</div>
                  <div className={`text-[10px] mt-0.5 ${kind === k.id ? 'text-white/80' : 'text-ink-muted'}`}>{k.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* サイトの種類（Webサイト選択時のみ） */}
          {kind === 'site' && (
            <div>
              <label className="text-xs font-semibold text-ink-secondary">サイトの種類</label>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {SITE_TYPES.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setSiteType(s.id)}
                    disabled={busy}
                    title={s.hint}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border text-left transition-colors disabled:opacity-50 ${
                      siteType === s.id
                        ? 'sakura-gradient text-white border-transparent'
                        : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                    }`}
                  >
                    <div>{s.label}</div>
                    <div className={`text-[10px] mt-0.5 ${siteType === s.id ? 'text-white/80' : 'text-ink-muted'}`}>{s.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* まっさら選択時の案内（公開先・要望欄は出さない＝何も決めずに空で始める） */}
          {kind === 'blank' && (
            <div className="text-xs text-ink-secondary bg-surface border border-line rounded-lg px-3 py-2.5 leading-relaxed">
              📄 <b className="text-ink">空のプロジェクト</b>を作ります。ファイルは作成しません。<br />
              作りたいものが決まったら、あとから<b className="text-ink">AIチャット</b>で「〇〇を作って」と頼めばそこから作れます。公開先も後で選べます。
            </div>
          )}

          {/* Deploy target（まっさらでは公開先を選ばせない＝あとで決める） */}
          {kind !== 'blank' && (
          <div>
            <label className="text-xs font-semibold text-ink-secondary">公開先</label>
            {TARGET_GROUPS.map(g => {
              const list = TARGETS.filter(t => t.group === g.key && isAvailableTarget(t.id))
              if (list.length === 0) return null
              return (
                <div key={g.key}>
                  <p className="mt-1.5 text-[11px] font-semibold text-ink-muted">{g.title}</p>
                  <div className="mt-1 grid grid-cols-2 gap-1.5">
                    {list.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setTarget(t.id)}
                        disabled={busy}
                        title={t.hint}
                        className={`px-3 py-2 rounded-lg text-xs font-medium border text-left transition-colors disabled:opacity-50 ${
                          target === t.id
                            ? 'sakura-gradient text-white border-transparent'
                            : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                        }`}
                      >
                        <div className="flex items-center gap-1">
                          {t.label}
                        </div>
                        <div className={`text-[10px] mt-0.5 ${target === t.id ? 'text-white/80' : 'text-ink-muted'}`}>
                          {t.hint}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {kind === 'site' && target === 'local' && (
              <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
                💡 Webサイトの公開には<b className="text-sakura">さくらのレンタルサーバ</b>がおすすめです（完成後に【③ 公開】からも選べます）。
              </p>
            )}
            {target === 'sakura-rental' && (
              <p className="mt-1.5 text-[11px] text-sakura leading-relaxed">
                {kind === 'site'
                  ? <>静的サイトを public/ 構成で生成し、<b>deploy.sh</b> で簡単に公開できます。</>
                  : <>PHP + MySQL 構成で生成し、<b>deploy.sh</b> で簡単に公開できます（ベース指定は無視されます）。</>}
              </p>
            )}
            {target === 'sakura-apprun' && (
              <p className="mt-1.5 text-[11px] text-sakura leading-relaxed">
                {kind === 'site'
                  ? <>静的サイトを nginx コンテナ構成で生成し、<b>③公開→さくらのAppRun</b> から Docker不要でそのまま公開できます。</>
                  : <>Docker コンテナ構成（Node.js + Dockerfile）で生成し、<b>③公開→さくらのAppRun</b> から Docker不要でそのまま公開できます（ベース指定は無視されます）。</>}
              </p>
            )}
            {(() => {
              const serviceUrl = getTargetProfile(target).serviceUrl
              const t = TARGETS.find(x => x.id === target)
              if (!serviceUrl || !t) return null
              return (
                <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
                  <a href={serviceUrl} className="hover:underline">🌐 {t.label}の公式サイトを見る ↗</a>
                </p>
              )
            })()}
          </div>
          )}

          {/* Template (base stack) — アプリのときのみ表示（サイトは静的HTML固定） */}
          {kind === 'app' && (
          <div>
            <label className="text-xs font-semibold text-ink-secondary">
              ベース {FIXED_STACK_TARGETS.includes(target) && <span className="text-ink-muted font-normal">（この公開先では専用構成で生成）</span>}
            </label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TEMPLATES.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTemplate(t.id)}
                  disabled={busy || FIXED_STACK_TARGETS.includes(target)}
                  title={t.hint}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 ${
                    template === t.id
                      ? 'sakura-gradient text-white border-transparent'
                      : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Description（まっさらでは要望を書かせない＝完全に空で始める） */}
          {kind !== 'blank' && (
          <div>
            <label className="text-xs font-semibold text-ink-secondary">{kind === 'site' ? 'どんなサイト？（任意）' : 'どんなアプリ？（任意）'}</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder={kind === 'site'
                ? '例：手作りパン屋のサイト。温かい雰囲気で、営業時間・アクセス・パンの紹介を載せたい。'
                : '例：TODOリストアプリ。タスクの追加・完了・削除ができて、ローカルに保存される。'}
              className="mt-1.5 w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura transition-colors resize-none disabled:opacity-50"
            />
          </div>
          )}

          {/* このあとチャットで作業するAI（頭脳＋モデル）。キーが登録されているものだけ表示する。
              まっさらはチャットへ依頼しないため出さない（brain が null＝どちらのキーも無いときも出さない）。
              選択はここでは保存のみ行い、作成実行時（runCreate）に setClaudeMode/setDefaultModel で
              実際にチャットの頭脳・モデルへ反映する（この後チャットが作業を引き継ぐため）。 */}
          {kind !== 'blank' && brain && (
            <div>
              <label className="text-xs font-semibold text-ink-secondary">このあとチャットで作業するAI</label>
              {apiKey && claudeKey ? (
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => chooseBrain('sakura')}
                    disabled={busy}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border text-left transition-colors disabled:opacity-50 ${
                      brain === 'sakura'
                        ? 'sakura-gradient text-white border-transparent'
                        : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                    }`}
                  >
                    さくらのAI Engine
                  </button>
                  <button
                    onClick={() => chooseBrain('claude')}
                    disabled={busy}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border text-left transition-colors disabled:opacity-50 ${
                      brain === 'claude'
                        ? 'sakura-gradient text-white border-transparent'
                        : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                    }`}
                  >
                    Claude
                  </button>
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-ink-secondary">
                  {brain === 'claude' ? 'Claude' : 'さくらのAI Engine'} が作成します
                </p>
              )}
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-[11px] text-ink-muted">モデル:</span>
                <ModelSelect
                  models={brain === 'claude' ? claudeModels : sakuraModels}
                  value={brain === 'claude' ? claudeModelId : sakuraModelId}
                  onChange={id => {
                    if (brain === 'claude') {
                      setClaudeModelId(id)
                      localStorage.setItem(NEWPROJECT_MODEL_CLAUDE_KEY, id)
                    } else {
                      setSakuraModelId(id)
                      localStorage.setItem(NEWPROJECT_MODEL_SAKURA_KEY, id)
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* No-key notice（まっさらは雛形も作らないので、この注意は不要） */}
          {!apiKey && !claudeKey && !busy && kind !== 'blank' && (
            <div className="text-xs text-ink-secondary bg-surface border border-line rounded-lg px-3 py-2 leading-relaxed">
              ⚠️ APIキーが未設定のため、<b className="text-ink">フォルダと最小限の雛形のみ</b>作成します。
              AIによるアプリ開発は行いません。キーは後から登録できます。
            </div>
          )}

          {/* Conflict: folder already exists → ask for a different name */}
          {conflict && !busy && (
            <div className="text-xs bg-surface border border-brand-yellow/60 rounded-lg px-3 py-2.5 space-y-2.5">
              <p className="text-ink leading-relaxed">
                ⚠️ 同名のフォルダが既に存在します。<b className="text-ink">別の名前</b>を指定してください。<br />
                <span className="text-ink-muted break-all">{conflict.path}</span>
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => createWithSuggestion(conflict.suggestion)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity"
                >
                  「{conflict.suggestion}」で作成
                </button>
                <button
                  onClick={() => setConflict(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-overlay text-ink border border-line hover:border-sakura transition-colors"
                >
                  自分で名前を入力
                </button>
              </div>
              <details className="text-ink-muted">
                <summary className="cursor-pointer hover:text-ink-secondary">その他の選択肢</summary>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <button
                    onClick={() => onCreated(conflict.path)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-overlay text-ink border border-line hover:border-sakura transition-colors"
                  >
                    既存のフォルダを開く
                  </button>
                  <button
                    onClick={() => runCreate(name, true)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-overlay text-ink border border-line hover:border-sakura transition-colors"
                    title="既存ファイルは上書きせず、不足分だけ追加します"
                  >
                    中に追加生成する
                  </button>
                </div>
              </details>
            </div>
          )}

          {error && (
            <div className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2">{error}</div>
          )}
          {busy && status && (
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="w-3 h-3 rounded-full border-2 border-sakura border-t-transparent animate-spin" />
              {status}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-ink-secondary bg-surface border border-line hover:text-ink transition-colors disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              onClick={create}
              disabled={busy || !name.trim() || !NAME_OK.test(name.trim())}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {busy ? '処理中...' : (apiKey || claudeKey) ? '✨ AIで作成' : 'フォルダを作成'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
