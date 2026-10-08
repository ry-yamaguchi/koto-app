import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// scanDataUsage / ensureDataLayer は electron の app を（テンプレートの場所を探すためだけに）読む。
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import {
  memoryKeepLines, looksLikeServerCode, isNotUserDataName, localImportSpecs, resolveLocalImport, serverReachableFiles,
} from '../src/shared/memoryKeep'
import { scanDataUsage, ensureDataLayer } from '../src/main/dataLayer'
import {
  storageNeedFor, storageNeedForScan, memorySitesFor, memorySitesNotWarned, memoryIsAProblem, shouldOfferStorage, type PublishTarget,
} from '../src/shared/storageNeed'
import {
  askAiRewriteText, askAiRewritePlan, rewriteCheckLine, rewriteCheckDone, storageNoticeHeadline,
} from '../src/shared/storageNoticeText'
import { judgeVercelFit } from '../src/shared/vercelFit'

// ── なぜこのテストが要るか（2026-10-01 rc.5 の実機）──────────────────────────
// 「名前を入れると一覧に出る簡単なアプリを作って」と頼んで HANAMII へ公開したところ、
// AI が作った server.js は、トップレベルの `const names = []` に `names.push(...)` で
// 入力を持つだけだった（ファイルにも koto-data にも書かない）。再起動・公開し直しで
// 名前が消えるのに、③公開の画面には保存場所の案内が**一切出なかった**。
// 判定が「koto-data を使う」「ファイルに書く」しか見ておらず、メモリだけに持つ形は
// kind 'none'（何も言わない）になっていたため。
//
// ここは**振る舞い**で固定する（掟10）: 実物の server.js を流して、検出・判定・依頼文・
// 確かめる文が出ること。ソースの文字列を読むだけのテストは memoryKeepWiring.test.ts の配線に限る。

/** 実機のアプリの server.js（要点・利用者が頼んで AI が作ったもの）。 */
const REAL_SERVER_JS = [
  "const express = require('express');",                                  // 1
  'const app = express();',                                               // 2
  '',                                                                     // 3
  'app.use(express.urlencoded({ extended: true }));',                     // 4
  '',                                                                     // 5
  'const names = [];',                                                    // 6
  '',                                                                     // 7
  "app.get('/healthz', (req, res) => {",                                  // 8
  "  res.status(200).send('OK');",                                        // 9
  '});',                                                                  // 10
  '',                                                                     // 11
  "app.get('/', (req, res) => {",                                         // 12
  '  const listHtml = names',                                             // 13
  '    .map((name, index) => `<li>${escapeHtml(name)}</li>`)',            // 14
  "    .join('');",                                                       // 15
  '  res.send(`<!DOCTYPE html>...<ul>${listHtml}</ul>...`);',             // 16
  '});',                                                                  // 17
  '',                                                                     // 18
  "app.post('/names', (req, res) => {",                                   // 19
  '  const name = req.body.name;',                                        // 20
  "  if (name && name.trim() !== '') {",                                  // 21
  '    names.push(name.trim());',                                         // 22
  '  }',                                                                  // 23
  "  res.redirect('/');",                                                 // 24
  '});',                                                                  // 25
  '',                                                                     // 26
  "function escapeHtml(text) { return text.replace(/&/g, '&amp;'); }",    // 27
  '',                                                                     // 28
  'const port = process.env.PORT || 8080;',                               // 29
  "app.listen(port, '0.0.0.0', () => {",                                  // 30
  '  console.log(`Server is running on port ${port}`);',                  // 31
  '});',                                                                  // 32
].join('\n')

describe('メモリだけに持つ形の検出（純関数）', () => {
  // ★ 実機の欠陥そのもの。書き換えの行（push の行）が返る
  it('★ 実機の server.js を検出する。lines は names.push の行（22行目）', () => {
    expect(memoryKeepLines(REAL_SERVER_JS)).toEqual([22])
  })

  // ★ 宣言だけ・読むだけは拾わない（キャッシュの読み出しや、設定の置き場を警告しない）
  it('トップレベルの `const cache = new Map()` を読むだけなら検出しない', () => {
    const src = [
      "const express = require('express')",
      'const app = express()',
      'const cache = new Map()',
      "app.get('/x', (req, res) => { res.send(String(cache.get('k'))) })",
      'app.listen(8080)',
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('宣言だけで何も書き換えていなければ検出しない', () => {
    const src = "const express = require('express')\nconst names = []\nexpress().listen(1)\n"
    expect(memoryKeepLines(src)).toEqual([])
  })

  // ★ ブラウザ側の JS は、サーバーの印が無いので拾わない
  it('サーバーの印の無いブラウザ側の JS で配列に push しても検出しない', () => {
    const src = [
      'const todos = []',
      "document.querySelector('#add').addEventListener('click', () => {",
      "  todos.push(document.querySelector('#t').value)",
      '})',
    ].join('\n')
    expect(looksLikeServerCode(src)).toBe(false)
    expect(memoryKeepLines(src)).toEqual([])
  })

  // ★ 関数の中の変数は、その呼び出しで消えるのが普通。字下げがあるものは宣言に数えない
  it('関数の中で宣言した配列（字下げあり）は検出しない', () => {
    const src = [
      "const express = require('express')",
      'const app = express()',
      "app.get('/', (req, res) => {",
      '  const rows = []',
      '  rows.push(1)',
      '  res.send(String(rows.length))',
      '})',
      'app.listen(8080)',
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  // ★ let の再代入（push しない書き方）も同じ形
  it('let の再代入 `items = [...items, x]` を検出する', () => {
    const src = [
      "import express from 'express'",       // 1
      'const app = express()',               // 2
      'let items = []',                      // 3
      "app.post('/add', (req, res) => {",    // 4
      '  items = [...items, req.body.x]',    // 5
      '  res.end()',                         // 6
      '})',                                  // 7
      'app.listen(3000)',                    // 8
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([5])
  })

  it('const は再代入できないので、同名の別の変数への代入を書き換えと数えない', () => {
    const src = [
      "const express = require('express')",
      'const names = []',
      'function f() { let names; names = 1 }', // 別の（関数内の）names。const の再代入ではない
      'express().listen(1)',
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('宣言そのもの（let items = []）を書き換えと数えない', () => {
    const src = "const http = require('http')\nlet items = []\nhttp.createServer(() => {}).listen(1)\n"
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('Map・Set・オブジェクトの書き換え（.set / .add / 添字 / プロパティ）を拾う', () => {
    const src = [
      "const http = require('http')",        // 1
      'const sessions = new Map()',          // 2
      'const seen = new Set()',              // 3
      'const byId = {}',                     // 4
      'const state = {}',                    // 5
      'http.createServer((req, res) => {',   // 6
      "  sessions.set('a', 1)",              // 7
      "  seen.add('a')",                     // 8
      "  byId[req.url] = 1",                 // 9
      '  state.count = 1',                   // 10
      '}).listen(8080)',                     // 11
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([7, 8, 9, 10])
  })

  it('TypeScript の型注釈・総称つきの宣言も読む', () => {
    const src = [
      "import { Hono } from 'hono'",                       // 1
      'const app = new Hono()',                            // 2
      'const items: string[] = []',                        // 3
      'const byName = new Map<string, number>()',          // 4
      "app.post('/', async (c) => {",                      // 5
      '  items.push(await c.req.text())',                  // 6
      "  byName.set('x', 1)",                              // 7
      '  return c.text("ok")',                             // 8
      '})',                                                // 9
      'export default app',                                // 10
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([6, 7])
  })

  // ★ 比較・別物の持ち物を書き換えと数えない
  it('比較（==, ===, >=）や this.names の書き換えは拾わない', () => {
    const src = [
      "const express = require('express')",
      'let names = []',
      'if (names === null || names == 1 || names >= 2) {}',
      'class A { f() { this.names = 1; other.names.push(1) } }',
      'express().listen(1)',
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('空・壊れた入力でも落ちない', () => {
    expect(memoryKeepLines('')).toEqual([])
    expect(memoryKeepLines(undefined as unknown as string)).toEqual([])
    expect(memoryKeepLines(null as unknown as string)).toEqual([])
  })

  it('名前に $ を含んでいても落ちず、検出する', () => {
    const src = "const http = require('http')\nconst $list = []\nhttp.createServer(() => { $list.push(1) }).listen(1)\n"
    expect(memoryKeepLines(src)).toEqual([3])
  })
})

describe('サーバー側のコードらしさ', () => {
  it.each([
    ["const express = require('express')"],
    ["import express from 'express'"],
    ["import Fastify from 'fastify'"],
    ["const Koa = require('koa')"],
    ["import { Hono } from 'hono'"],
    ["import http from 'node:http'"],
    ["const http = require('http')"],
    ['http.createServer(handler)'],
    ['app.listen(8080)'],
    ['export default function handler(req, res) {}'],
    ['export default async function handler(req, res) {}'],
    // 引数の名前が違っても、`handler` という名前の関数なら Vercel の関数の形
    ['export default function handler(r, s) {}'],
    ['export default async function handler() {}'],
    ['export async function GET(request) {}'],
    ['export async function POST(request) {}'],
    ['module.exports = (req, res) => {}'],
  ])('サーバーの印: %s', (src) => {
    expect(looksLikeServerCode(src)).toBe(true)
  })

  it.each([
    ['const x = []'],
    ["document.querySelector('a')"],
    ["import React from 'react'"],
    ["import http2tools from 'http-proxy'"], // 名前が似ているだけの別の部品
  ])('サーバーの印ではない: %s', (src) => {
    expect(looksLikeServerCode(src)).toBe(false)
  })

  it('Vercel のサーバーレス関数の先頭にある配列への push を検出する', () => {
    const src = [
      'const entries = []',                                  // 1
      'export default function handler(req, res) {',          // 2
      '  entries.push(req.body)',                             // 3
      '  res.json(entries)',                                  // 4
      '}',                                                    // 5
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([3])
  })
})

// ── 2026-10-01 検分で足した形 ───────────────────────────────────────────────
// 最初の版は「空の [] / {} / new Map() / new Set() の宣言」と「= の付く書き換え」だけを見ていた。
// ToDo の見本データ・投票・在庫は、Koto の利用者がよく頼むアプリそのものなのに、拾えなかった。

describe('初期値つきの入れ物・++・入れ子の持ち物（検分で足した形）', () => {
  /** サーバーの印（express・listen）で挟む。本文は3行目から始まる。 */
  const wrap = (body: string[]) =>
    ["const express = require('express')", 'const app = express()', ...body, 'app.listen(8080)'].join('\n')

  // ★ ToDo の見本データを最初から入れておく書き方
  it('★ 見本データ入りの配列（let todos = [{…}]）への push を検出する', () => {
    const src = wrap([
      'let todos = [',                              // 3
      '  { id: 1, title: "牛乳を買う" },',           // 4
      '  { id: 2, title: "メールを書く" },',         // 5
      ']',                                          // 6
      "app.post('/todos', (req, res) => {",         // 7
      '  todos.push(req.body)',                     // 8
      '  res.end()',                                // 9
      '})',                                         // 10
    ])
    expect(memoryKeepLines(src)).toEqual([8])
  })

  it('★ 入れ物オブジェクト（const db = { users: [], posts: [] }）の中の配列への push を検出する', () => {
    const src = wrap([
      'const db = { users: [], posts: [] }',        // 3
      "app.post('/p', (req, res) => {",             // 4
      '  db.posts.push(req.body)',                  // 5
      '  res.end()',
      '})',
    ])
    expect(memoryKeepLines(src)).toEqual([5])
  })

  // ★ 投票の数。`=` が無い（++）ので、最初の版は宣言（空でない）と書き換えの両方で漏れた
  it('★ 投票の数 votes[choice]++ を検出する（前置・後置・-- ・+= も）', () => {
    const src = wrap([
      'const votes = { cat: 0, dog: 0 }',           // 3
      "app.post('/vote', (req, res) => {",          // 4
      '  votes[req.body.choice]++',                 // 5
      '  ++votes.cat',                              // 6
      '  votes.dog--',                              // 7
      '  votes[req.body.choice] += 1',              // 8
      '  res.end()',
      '})',
    ])
    expect(memoryKeepLines(src)).toEqual([5, 6, 7, 8])
  })

  it('初期値つきの Map・new Array() への書き換えも検出する', () => {
    const src = wrap([
      "const stock = new Map([['apple', 10], ['pear', 3]])",   // 3
      'const names = new Array()',                              // 4
      "app.post('/s', (req, res) => {",                        // 5
      "  stock.set('apple', 9)",                               // 6
      '  names.push(req.body.n)',                              // 7
      '  res.end()',
      '})',
    ])
    expect(memoryKeepLines(src)).toEqual([6, 7])
  })

  it('入れ子の持ち物の代入（db.posts[0].title = …）も検出する', () => {
    const src = wrap([
      'const db = { posts: [] }',                   // 3
      "app.post('/e', (req, res) => {",             // 4
      "  db.posts[0].title = req.body.title",       // 5
      '  res.end()',
      '})',
    ])
    expect(memoryKeepLines(src)).toEqual([5])
  })

  // ★ 広げても、読むだけのものは拾わない（宣言だけ・読むだけは拾わない、は変わらない）
  it('見本データ入りでも、読むだけなら検出しない（価格表・設定など）', () => {
    const src = wrap([
      'const PRICES = { apple: 100, pear: 80 }',
      "app.get('/p', (req, res) => { res.json(PRICES[req.query.k]) })",
      'const colors = ["red", "blue"]',
      "app.get('/c', (req, res) => { res.json(colors.map(c => c.toUpperCase())) })",
    ])
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('比較の =>・>=・<= を代入と数えない（広げた書き方でも）', () => {
    const src = wrap([
      'const state = { n: 0 }',
      'if (state.n >= 2 || state.n <= 1 || state.n != 3 || state.n == 4) {}',
    ])
    expect(memoryKeepLines(src)).toEqual([])
  })
})

describe('起動時に1度だけ走る書き換えは数えない（検分で足した除外）', () => {
  // ★ 設定の組み立てを「入力されたデータをメモリに持っている」と数えない
  it('★ 字下げの無い行の設定の代入・許可リストの組み立てを、書き換えと数えない', () => {
    const src = [
      "const express = require('express')",                                   // 1
      'const settings = {}',                                                  // 2
      'settings.port = process.env.PORT || 8080',                             // 3
      'const allowedOrigins = []',                                            // 4
      'if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL)', // 5
      'express().listen(settings.port)',                                      // 6
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  // ★ 1行に書いたハンドラは、リクエストのたびに走る。数える
  it('★ 1行に書いたハンドラの中の書き換えは数える（=> / function を含む行）', () => {
    const arrow = "const express = require('express')\nconst names = []\nexpress().post('/', (req, res) => { names.push(req.body.n); res.end() }).listen(1)\n"
    const fn = "const express = require('express')\nconst names = []\nexpress().post('/', function (req, res) { names.push(req.body.n) }).listen(1)\n"
    expect(memoryKeepLines(arrow)).toEqual([3])
    expect(memoryKeepLines(fn)).toEqual([3])
  })

  it('起動時に見本を1つ入れる push は数えず、リクエストの中の push だけを数える', () => {
    const src = [
      "const express = require('express')",                // 1
      'const names = []',                                  // 2
      "names.push('初期データ')",                           // 3 ← 起動時に1度だけ
      "express().post('/', (req, res) => {",               // 4
      '  names.push(req.body.n)',                          // 5 ← リクエストのたび
      '}).listen(1)',                                      // 6
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([5])
  })
})

describe('「持たせるデータではない」名前は数えない（キャッシュ・回数制限・接続の一覧）', () => {
  it.each([
    ['cache'], ['weatherCache'], ['rateLimitMap'], ['RATE_LIMIT'], ['ratelimit'], ['limiter'],
    ['hits'], ['wsConnections'], ['sockets'], ['timers'], ['cachedResults'],
  ])('数えない名前: %s', (name) => {
    expect(isNotUserDataName(name)).toBe(true)
  })

  it.each([
    ['names'], ['todos'], ['posts'], ['sessions'], ['memos'], ['entries'], ['votes'],
    // 語の一部が似ているだけ（rate / limit / cache を含むが、別の語）
    ['generated'], ['operate'], ['accelerate'], ['climbers'], ['clientList'],
    // clients は顧客の一覧のこともあるので、名前だけでは外さない（接続の Set のときだけ外す・2026-10-01 検分2巡目）
    ['clients'], ['sseClients'], ['SSE_CLIENTS'],
  ])('数える名前: %s', (name) => {
    expect(isNotUserDataName(name)).toBe(false)
  })

  // ★ 回数制限・キャッシュ・SSE の接続を「データが消えます」と言い、AI に書き直させて壊すのを防ぐ
  it('★ 回数制限の Map・天気のキャッシュ・SSE の接続を持つ Set は、書き換えても検出しない', () => {
    const rate = [
      "const express = require('express')",
      'const hits = new Map()',
      "express().use((req, res, next) => { hits.set(req.ip, Date.now()); next() }).listen(1)",
    ].join('\n')
    const weather = [
      "const express = require('express')",
      'const cache = {}',
      "express().get('/w', (req, res) => { cache[req.query.city] = { t: 1 }; res.end() }).listen(1)",
    ].join('\n')
    const sse = [
      "const express = require('express')",
      'const clients = new Set()',
      "express().get('/events', (req, res) => { clients.add(res) }).listen(1)",
    ].join('\n')
    expect(memoryKeepLines(rate)).toEqual([])
    expect(memoryKeepLines(weather)).toEqual([])
    expect(memoryKeepLines(sse)).toEqual([])
  })

  it('同じファイルにキャッシュと入力データがあれば、入力データの側だけを検出する', () => {
    const src = [
      "const express = require('express')",                                  // 1
      'const cache = {}',                                                    // 2
      'const names = []',                                                    // 3
      "express().post('/', (req, res) => {",                                 // 4
      '  cache[req.url] = 1',                                                // 5
      '  names.push(req.body.n)',                                            // 6
      '}).listen(1)',                                                        // 7
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([6])
  })

  it('セッションの Map は数える（消えるとログアウトになる）', () => {
    const src = "const express = require('express')\nconst sessions = new Map()\nexpress().post('/login', (req, res) => { sessions.set(req.body.u, 1) }).listen(1)\n"
    expect(memoryKeepLines(src)).toEqual([3])
  })
})

describe('サーバーの印の足し方（検分で足した形）', () => {
  it.each([
    ["'use server'\nexport async function add(text) {}"],
    ['"use server"\nexport async function add(text) {}'],
    ["import x from './x'\n'use server'\nexport const a = 1"],
    ['const wss = new WebSocketServer({ port: 8080 })'],
    ["const { WebSocketServer } = require('ws')"],
    ["import { Server } from 'socket.io'"],
  ])('サーバーの印: %s', (src) => {
    expect(looksLikeServerCode(src)).toBe(true)
  })

  it.each([
    ["import io from 'socket.io-client'"],  // ブラウザ側の部品
    ["const s = 'use server'"],              // 行頭ではない（文字列の中）
    ["import ws from 'wsx'"],                // 名前が似ているだけ
  ])('サーバーの印ではない: %s', (src) => {
    expect(looksLikeServerCode(src)).toBe(false)
  })

  it('Next.js の Server Actions のファイルの先頭にある配列への push を検出する', () => {
    const src = [
      "'use server'",                                 // 1
      'const messages: string[] = []',                // 2
      'export async function post(text: string) {',   // 3
      '  messages.push(text)',                        // 4
      '}',                                            // 5
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([4])
  })

  it('ws だけで待ち受けるチャットの履歴を検出する', () => {
    const src = [
      "const { WebSocketServer } = require('ws')",            // 1
      'const wss = new WebSocketServer({ port: 8080 })',      // 2
      'const history = []',                                   // 3
      "wss.on('connection', (socket) => {",                   // 4
      "  socket.on('message', (m) => { history.push(String(m)) })", // 5
      '})',                                                   // 6
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([5])
  })
})

describe('別のファイルに分けた入れ物（読み込みの解決・純関数）', () => {
  it('localImportSpecs: 自分のプロジェクトのファイルの読み込みだけを集める', () => {
    const src = [
      "import a from './a'",
      'const b = require("../b")',
      "const c = await import('./c')",
      "import './d'",
      "import { s } from '@/lib/store'",
      "import { t } from '~/lib/t'",
      "import express from 'express'",
      "import React from 'react'",
      "import u from 'node:url'",
    ].join('\n')
    expect(localImportSpecs(src).sort()).toEqual(['../b', './a', './c', './d', '@/lib/store', '~/lib/t'].sort())
    expect(localImportSpecs('')).toEqual([])
    expect(localImportSpecs(undefined as unknown as string)).toEqual([])
  })

  const known = new Map(['server.js', 'store.js', 'store2.ts', 'lib/index.js', 'lib/store.ts', 'src/lib/data.ts', 'app/api/todos/route.ts']
    .map(f => [f, f] as [string, string]))

  it('resolveLocalImport: 拡張子の省略・index の省略・@/ の別名・.js と書いて .ts を指す形を読む', () => {
    expect(resolveLocalImport('server.js', './store', known)).toBe('store.js')
    expect(resolveLocalImport('server.js', './store.js', known)).toBe('store.js')
    expect(resolveLocalImport('server.js', './store2.js', known)).toBe('store2.ts')
    expect(resolveLocalImport('server.js', './lib', known)).toBe('lib/index.js')
    expect(resolveLocalImport('app/api/todos/route.ts', '../../../lib/store', known)).toBe('lib/store.ts')
    expect(resolveLocalImport('app/api/todos/route.ts', '@/lib/store', known)).toBe('lib/store.ts')
    // @/ は src/ の下も見る
    expect(resolveLocalImport('app/api/todos/route.ts', '@/lib/data', known)).toBe('src/lib/data.ts')
    expect(resolveLocalImport('app/api/todos/route.ts', '~/lib/store', known)).toBe('lib/store.ts')
  })

  it('resolveLocalImport: 見つからない・プロジェクトの外へ出る・パッケージ名は null', () => {
    expect(resolveLocalImport('server.js', './nothing', known)).toBeNull()
    expect(resolveLocalImport('server.js', '../outside', known)).toBeNull()
    expect(resolveLocalImport('server.js', 'express', known)).toBeNull()
  })

  it('serverReachableFiles: サーバーの印のあるファイルと、そこから（間接にも）読み込まれるファイルだけ', () => {
    const files = [
      { file: 'server.js', server: true, imports: ['./routes'] },
      { file: 'routes.js', server: false, imports: ['./store'] },
      { file: 'store.js', server: false, imports: [] },
      { file: 'browser.js', server: false, imports: ['./store'] }, // サーバーから読まれていない
      { file: 'orphan.js', server: false, imports: [] },
    ]
    const reached = serverReachableFiles(files)
    expect([...reached].sort()).toEqual(['routes.js', 'server.js', 'store.js'])
  })

  it('serverReachableFiles: 読み込みが輪になっていても止まる', () => {
    const files = [
      { file: 'a.js', server: true, imports: ['./b'] },
      { file: 'b.js', server: false, imports: ['./a'] },
    ]
    expect([...serverReachableFiles(files)].sort()).toEqual(['a.js', 'b.js'])
  })
})

// ── 走査（main 側）: 実ファイルを置いて歩く ─────────────────────────────────

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-memkeep-')) })
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ } })

const write = (rel: string, text: string) => {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

describe('走査: keepsInMemory', () => {
  it('★ 実機の server.js を置くと、server.js の22行目が見つかる（ほかの信号は空）', () => {
    write('package.json', '{"name":"names-app","dependencies":{"express":"^4"}}')
    write('server.js', REAL_SERVER_JS)

    const scan = scanDataUsage(dir)
    expect(scan.keepsInMemory).toEqual([{ file: 'server.js', lines: [22] }])
    expect(scan.writesFiles).toEqual([])
    expect(scan.usedBy).toEqual([])
    expect(scan.truncated).toBe(false)
  })

  it('サブフォルダのサーバーも、相対パスで見つかる', () => {
    write('api/index.js', REAL_SERVER_JS)
    expect(scanDataUsage(dir).keepsInMemory).toEqual([{ file: path.join('api', 'index.js'), lines: [22] }])
  })

  // ★ 除外は writesFiles と同じ名簿。node_modules の中のサーバーを利用者のコードと数えない
  it('node_modules の中のファイルは見ない', () => {
    write('node_modules/some-lib/server.js', REAL_SERVER_JS)
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  it('Koto が置く koto-data.js / koto-data.cjs は見ない（中の配列を利用者のコードと数えない）', () => {
    const layer = "const http = require('http')\nconst pending = []\nhttp.createServer(() => { pending.push(1) }).listen(1)\n"
    write('koto-data.js', layer)
    write('koto-data.cjs', layer)
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  it('手元のデータ置き場（.koto-data）の中は見ない', () => {
    write('.koto-data/x.js', REAL_SERVER_JS)
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  // ★ koto-data を使っているかとは別の観点。両方に載りうる（else で外さない）
  it('koto-data を使うファイルでも、メモリの形は拾う（走査は拾い、判定が警告を出さない）', () => {
    write('server.js', [
      "const express = require('express')",
      "const { save } = require('./koto-data.cjs')",
      'const drafts = new Map()',
      "express().post('/', async (req, res) => { drafts.set('a', 1); await save('k', {}) }).listen(1)",
    ].join('\n'))
    const scan = scanDataUsage(dir)
    expect(scan.usedBy).toEqual(['server.js'])
    expect(scan.keepsInMemory.map(w => w.file)).toEqual(['server.js'])
    // …が、警告にはしない（キャッシュの誤検知を避ける）
    const need = storageNeedForScan({ usesDataLayer: scan.usedBy.length > 0, writesFiles: scan.writesFiles, keepsInMemory: scan.keepsInMemory }, 'hanamii')
    expect(need.kind).toBe('declared')
  })
})

describe('置く条件: メモリだけに持つアプリにも koto-data を置く（AIに書き直してもらう導線のため）', () => {
  // ★ ここが外れると、警告は出るのに「AIに書き直してもらう」だけが
  //   「保存の部品を用意できませんでした」で必ず失敗する
  it('★ メモリだけに持つアプリでも、ready: true になる（依頼文を送ってよい）', () => {
    write('package.json', '{"name":"names-app"}')
    write('server.js', REAL_SERVER_JS)

    const r = ensureDataLayer(dir)
    expect(r.ready).toBe(true)
    expect(r.placed).toBe(true)
    expect(r.file).toBe('koto-data.cjs')
    expect(fs.existsSync(path.join(dir, 'koto-data.cjs'))).toBe(true)
    // そのまま依頼文を送る判断（画面と同じ関数）も「送ってよい」になる
    // （`ok` は IPC の storage:ensureLayer が足すもの）
    const plan = askAiRewritePlan([], { ...r, ok: true }, scanDataUsage(dir).keepsInMemory)
    expect(plan.send).toBe(true)
  })

  it('.mjs のサーバーなら import 版を置く（アプリの形に合わせる）', () => {
    write('server.mjs', REAL_SERVER_JS.replace("const express = require('express');", "import express from 'express';"))
    const r = ensureDataLayer(dir)
    expect(r.moduleKind).toBe('esm')
    expect(r.file).toBe('koto-data.js')
  })

  it('メモリの形が無ければ、これまでどおり置かない', () => {
    write('server.js', "const express = require('express')\nconst names = []\nexpress().listen(1)\n")
    const r = ensureDataLayer(dir)
    expect(r.ready).toBe(false)
    expect(r.placed).toBe(false)
  })
})

// ── 判定（storageNeedFor）────────────────────────────────────────────────

const STATELESS: PublishTarget[] = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'vercel']

describe('保存場所の要否: メモリだけに持つ形', () => {
  // ★ 実機の欠陥。これまでは 'none'（何も言わない）だった
  it('★ koto-data を使わず、メモリだけに持つなら、公開先が保てない側では will-lose-data', () => {
    for (const t of STATELESS) {
      const need = storageNeedFor({ usesDataLayer: false, writesFiles: false, keepsInMemory: true, target: t })
      expect(need.kind).toBe('will-lose-data')
      expect(shouldOfferStorage(need)).toBe(true)
      // 推定であることを言う（「ようです」）。断定しない
      expect(need.kind === 'will-lose-data' && need.note).toContain('メモリ')
      expect(need.kind === 'will-lose-data' && need.note).toContain('ようです')
      expect(need.kind === 'will-lose-data' && need.note).toContain('再起動や公開し直しのたびに消えます')
      expect(need.kind === 'will-lose-data' && need.note).toContain('「データの保存」を使う形へ書き直してもらってください')
    }
  })

  it('メモリの形が無ければ、これまでどおり none', () => {
    for (const t of STATELESS) {
      expect(storageNeedFor({ usesDataLayer: false, writesFiles: false, keepsInMemory: false, target: t }).kind).toBe('none')
    }
  })

  // ★ キャッシュの誤検知を避ける
  it('★ koto-data を使っているなら、メモリを理由に警告しない', () => {
    for (const t of STATELESS) {
      const need = storageNeedFor({ usesDataLayer: true, writesFiles: false, keepsInMemory: true, target: t })
      expect(need.kind).toBe('declared')
    }
  })

  // ★ Node の常駐アプリを置く公開先ではない
  it('★ レンタルサーバは対象外（メモリの形があっても、何も出さない）', () => {
    const need = storageNeedFor({ usesDataLayer: false, writesFiles: false, keepsInMemory: true, target: 'sakura-rental' })
    expect(need.kind).toBe('none')
    expect(shouldOfferStorage(need)).toBe(false)
  })

  it('レンタルサーバで、ファイル書き込みもあるときは、これまでどおり「残る」と言う（メモリは理由にしない）', () => {
    const need = storageNeedFor({ usesDataLayer: false, writesFiles: true, keepsInMemory: true, target: 'sakura-rental' })
    expect(need.kind).toBe('target-provides')
  })

  // ★ 両方あるときは、両方が分かる文にする（片方だけ言うと、直したつもりで残りが消える）
  it('★ ファイル書き込みとメモリの両方があるときは、両方が分かる文', () => {
    for (const t of STATELESS) {
      const need = storageNeedFor({ usesDataLayer: false, writesFiles: true, keepsInMemory: true, target: t })
      expect(need.kind).toBe('will-lose-data')
      const note = need.kind === 'will-lose-data' ? need.note : ''
      expect(note).toContain('ファイルにデータを書いている')
      expect(note).toContain('メモリ')
      expect(note).toContain('ようです')
    }
  })

  it('ファイル書き込みだけのときの文は、これまでと変わらない（メモリの話を混ぜない）', () => {
    const need = storageNeedFor({ usesDataLayer: false, writesFiles: true, keepsInMemory: false, target: 'hanamii' })
    expect(need.kind === 'will-lose-data' && need.note).toContain('このアプリはファイルにデータを書いています。')
    expect(need.kind === 'will-lose-data' && need.note).not.toContain('メモリ')
  })

  it('koto-data を使っていてファイル書き込みが残るときは、メモリがあっても文はファイルの話だけ', () => {
    const need = storageNeedFor({ usesDataLayer: true, writesFiles: true, keepsInMemory: true, target: 'hanamii' })
    expect(need.kind).toBe('will-lose-data')
    expect(need.kind === 'will-lose-data' && need.note).toContain('ファイルに直接書いている箇所が残っています')
    expect(need.kind === 'will-lose-data' && need.note).not.toContain('メモリ')
  })

  it('Markdown 記法を混ぜない', () => {
    for (const t of STATELESS) {
      for (const writesFiles of [false, true]) {
        const n = storageNeedFor({ usesDataLayer: false, writesFiles, keepsInMemory: true, target: t })
        expect('note' in n ? n.note : '').not.toMatch(/\*\*|__|`/)
      }
    }
  })

  it('memoryIsAProblem: 数えるのは「koto-data を使っていない」かつ「公開先が保てない」ときだけ', () => {
    expect(memoryIsAProblem({ usesDataLayer: false, target: 'hanamii' })).toBe(true)
    expect(memoryIsAProblem({ usesDataLayer: true, target: 'hanamii' })).toBe(false)
    expect(memoryIsAProblem({ usesDataLayer: false, target: 'sakura-rental' })).toBe(false)
  })
})

describe('画面が通す入口: storageNeedForScan / memorySitesFor（走査の結果の形のまま渡す）', () => {
  const site = [{ file: 'server.js', lines: [22] }]

  it('★ 走査の結果（keepsInMemory あり）を渡すと will-lose-data になる', () => {
    const scan = { usesDataLayer: false, writesFiles: [], keepsInMemory: site }
    expect(storageNeedForScan(scan, 'hanamii').kind).toBe('will-lose-data')
  })

  it('keepsInMemory が空・来なかったときは none（古い形の応答でも落ちない）', () => {
    expect(storageNeedForScan({ usesDataLayer: false, writesFiles: [], keepsInMemory: [] }, 'hanamii').kind).toBe('none')
    expect(storageNeedForScan({ usesDataLayer: false, writesFiles: [] } as never, 'hanamii').kind).toBe('none')
  })

  it('警告の理由に数えるときだけ、場所を返す（理由にならないのに場所だけ出さない）', () => {
    expect(memorySitesFor({ usesDataLayer: false, writesFiles: [], keepsInMemory: site }, 'hanamii')).toEqual(site)
    expect(memorySitesFor({ usesDataLayer: true, writesFiles: [], keepsInMemory: site }, 'hanamii')).toEqual([])
    expect(memorySitesFor({ usesDataLayer: false, writesFiles: [], keepsInMemory: site }, 'sakura-rental')).toEqual([])
  })
})

// ── AI への依頼文・確かめる文 ───────────────────────────────────────────────

describe('AI への依頼文: メモリだけに持っている場所を渡す', () => {
  const mem = [{ file: 'server.js', lines: [22] }]

  // ★ 場所を渡さないと AI は自分の記憶で「完了しました」と答える（2026-09-23 の事故と同じ形）
  it('★ メモリの場所（ファイル名と行番号）と、koto-data の list/get/save/remove で保存する形への書き直しを頼む', () => {
    const text = askAiRewriteText([], 'cjs', mem)
    expect(text).toContain('server.js の 22行目')
    expect(text).toContain('変数や配列')
    expect(text).toContain('list / get / save / remove')
    expect(text).toContain("const { list, get, save, remove } = require('./koto-data.cjs')")
    expect(text).toContain('書き直してください')
    // 読み直して確かめてから完了と答えさせる（この仕組みの根っこ）
    expect(text).toContain('読み直して')
    expect(text).toContain('残っていないことを確かめて')
    expect(text).toContain('完了と答えて')
    // アプリの形を変えさせない
    expect(text).toContain('package.json の "type" は変更しないでください')
    // 画面に出る素のテキストなので Markdown 記法は使わない
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })

  it('import のアプリには import の1行を渡す', () => {
    expect(askAiRewriteText([], 'esm', mem)).toContain("import { list, get, save, remove } from './koto-data.js'")
  })

  it('ファイル書き込みとメモリの両方があれば、両方の場所を入れる', () => {
    const text = askAiRewriteText([{ file: 'a.js', lines: [3] }], 'cjs', mem)
    expect(text).toContain('a.js の 3行目')
    expect(text).toContain('server.js の 22行目')
    expect(text).toContain('ファイルへの書き込みと、')
  })

  it('メモリの場所が無いとき（空・省略）は、これまでとまったく同じ文', () => {
    const site = [{ file: 'public/server.js', lines: [66] }]
    expect(askAiRewriteText(site, 'esm', [])).toBe(askAiRewriteText(site, 'esm'))
    expect(askAiRewriteText(site, 'esm')).toContain('ファイルに直接書き込んでいるのは public/server.js の 66行目 です。')
    expect(askAiRewriteText(site, 'esm')).not.toContain('変数や配列')
  })

  it('askAiRewritePlan: 置けたときは、メモリの場所を入れた文を送る', () => {
    const plan = askAiRewritePlan([], { ok: true, ready: true, moduleKind: 'cjs' }, mem)
    expect(plan.send).toBe(true)
    expect(plan.send && plan.text).toContain('server.js の 22行目')
  })

  it('askAiRewritePlan: 置けなかったときは、メモリの場合も送らない', () => {
    const plan = askAiRewritePlan([], { ok: true, ready: false }, mem)
    expect(plan.send).toBe(false)
  })
})

describe('書き直せたかを確かめた結果: メモリだけに持つ形が残っているとき', () => {
  const mem = [{ file: 'server.js', lines: [22] }]

  // ★ 「AI は完了と言うが何も変わっていない」を、場所つきで突き返せる
  it('★ まだ残っていれば ❌ で場所を名指しする（✅ にも ℹ️ にも倒さない）', () => {
    const line = rewriteCheckLine({ usesDataLayer: false, writesFiles: [], keepsInMemory: mem })
    expect(line).toContain('❌')
    expect(line).toContain('まだ書き直されていません')
    expect(line).toContain('server.js の 22行目')
    expect(line).toContain('メモリ')
    expect(line).not.toContain('✅')
  })

  it('ファイル書き込みとメモリの両方が残っていれば、両方を名指しする', () => {
    const line = rewriteCheckLine({ usesDataLayer: false, writesFiles: [{ file: 'a.js', lines: [3] }], keepsInMemory: mem })
    expect(line).toContain('a.js の 3行目')
    expect(line).toContain('server.js の 22行目')
  })

  it('メモリの場所が空なら、これまでの文のまま（koto-data を使った書き直し後は ✅）', () => {
    expect(rewriteCheckLine({ usesDataLayer: true, writesFiles: [], keepsInMemory: [] })).toContain('✅')
    expect(rewriteCheckLine({ usesDataLayer: true, writesFiles: [] })).toContain('✅')
  })

  it('✅ の条件（rewriteCheckDone）は変わらない: koto-data を使い、書き込みが無く、打ち切りでない', () => {
    expect(rewriteCheckDone({ usesDataLayer: true, writesFiles: [], keepsInMemory: [] })).toBe(true)
    expect(rewriteCheckDone({ usesDataLayer: false, writesFiles: [], keepsInMemory: mem })).toBe(false)
  })
})

// ── Vercel ──────────────────────────────────────────────────────────────

describe('Vercel の確認: メモリだけに持つ形を「データは残らない」側に倒す', () => {
  const base = { packageJson: null, listens: [], usesData: [], hasStorage: false, hasFiles: true }
  const storage = (extra: Record<string, unknown>) =>
    judgeVercelFit({ ...base, ...extra } as never).find(c => c.id === 'storage')!

  it('★ メモリだけに持つなら、データの行を ✅ で通さない（warn・AIに書き直してもらう導線つき）', () => {
    const c = storage({ keepsInMemory: ['api/save.js'] })
    expect(c.status).toBe('warn')
    expect(c.fix).toBe('ask-ai')
    expect(c.note).toContain('api/save.js')
    expect(c.note).toContain('メモリ')
    expect(c.note).toContain('ようです')
    expect(c.note).toContain('残りません')
    expect(c.note).not.toMatch(/\*\*|`/)
  })

  it('メモリの形が無い・渡されていないときは、これまでどおり ✅', () => {
    expect(storage({ keepsInMemory: [] }).status).toBe('ok')
    expect(storage({}).status).toBe('ok')
  })

  it('★ koto-data を使っているなら、メモリを理由に警告しない（文にもメモリが出ない）', () => {
    const c = storage({ usesData: ['api/x.js'], keepsInMemory: ['api/x.js'], hasStorage: true })
    expect(c.note).not.toContain('メモリ')
  })

  it('ファイル直書きだけのときの文は、これまでと一字も変わらない', () => {
    const c = storage({ writesFiles: ['server.js'] })
    expect(c.note).toBe(
      'このアプリはデータの保存（koto-data）を使っていませんが、ファイルに直接書いて保存している箇所があります（server.js）。'
      + 'そこに書かれたデータは残りません（何もしなくても消えることがあります）。'
      + '上の「AIに書き直してもらう」から koto-data へ書き直すと、データが残るようになります。',
    )
  })

  it('両方あれば、両方を言う', () => {
    const c = storage({ writesFiles: ['a.js'], keepsInMemory: ['b.js'] })
    expect(c.note).toContain('ファイルに直接書いて保存している箇所があります（a.js）')
    expect(c.note).toContain('メモリ')
    expect(c.note).toContain('b.js')
  })
})

describe('走査: 入れ物を別のファイルに分けた形（検分で足した形）', () => {
  // ★ Next.js で AI が書く定番。入れ物は lib/store.ts、route.ts はそれを呼ぶだけ
  it('★ Next.js: lib/store.ts の入れ物は、route.ts（サーバーの印あり）から読み込まれているので検出する', () => {
    write('package.json', '{"name":"next-app","dependencies":{"next":"14"}}')
    write('lib/store.ts', [
      'export type Todo = { id: number; title: string }',        // 1
      'export const todos: Todo[] = []',                          // 2
      'export function addTodo(t: Todo) {',                       // 3
      '  todos.push(t)',                                          // 4
      '}',                                                        // 5
    ].join('\n'))
    write('app/api/todos/route.ts', [
      "import { addTodo, todos } from '@/lib/store'",
      'export async function POST(request: Request) {',
      '  addTodo(await request.json())',
      '  return Response.json(todos)',
      '}',
    ].join('\n'))

    const scan = scanDataUsage(dir)
    // 入れ物のあるファイル（lib/store.ts の4行目）。route.ts は書き換えていないので載らない
    expect(scan.keepsInMemory).toEqual([{ file: path.join('lib', 'store.ts'), lines: [4] }])
    expect(storageNeedForScan({ usesDataLayer: false, writesFiles: [], keepsInMemory: scan.keepsInMemory }, 'hanamii').kind).toBe('will-lose-data')
    // Vercel の確認も ✅ で通さない
    const v = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasFiles: true, hasStorage: false,
      keepsInMemory: scan.keepsInMemory.map(w => w.file) } as never).find(c => c.id === 'storage')!
    expect(v.status).toBe('warn')
  })

  it('★ express: store.js に分けた入れ物を、server.js が require していれば検出する', () => {
    write('store.js', 'const items = []\nexports.add = (x) => { items.push(x) }\nexports.all = () => items\n')
    write('server.js', "const express = require('express')\nconst store = require('./store')\nexpress().listen(8080)\n")
    expect(scanDataUsage(dir).keepsInMemory).toEqual([{ file: 'store.js', lines: [2] }])
  })

  it('★ ルート定義だけのファイル（module.exports = (app) => {…}）も、server.js から読み込まれていれば検出する', () => {
    write('routes.js', [
      'const posts = []',                                         // 1
      'module.exports = (app) => {',                              // 2
      "  app.post('/posts', (req, res) => { posts.push(req.body); res.end() })", // 3
      '}',                                                        // 4
    ].join('\n'))
    write('server.js', "const express = require('express')\nconst app = express()\nrequire('./routes')(app)\napp.listen(8080)\n")
    expect(scanDataUsage(dir).keepsInMemory).toEqual([{ file: 'routes.js', lines: [3] }])
  })

  it('間接に読み込まれていても検出する（server.js → service.js → store.js）', () => {
    write('store.js', 'const rows = []\nexports.add = (x) => { rows.push(x) }\n')
    write('service.js', "const store = require('./store')\nexports.save = (x) => store.add(x)\n")
    write('server.js', "const express = require('express')\nconst svc = require('./service')\nexpress().listen(1)\n")
    expect(scanDataUsage(dir).keepsInMemory).toEqual([{ file: 'store.js', lines: [2] }])
  })

  // ★ サーバーから読み込まれていないファイルまで数えない（ブラウザ側の JS を警告しない）
  it('★ サーバーの印が無く、サーバーからも読み込まれていないファイルは、配列に push していても検出しない', () => {
    write('server.js', "const express = require('express')\nexpress().listen(1)\n")
    write('public/app.js', "const todos = []\ndocument.querySelector('#a').addEventListener('click', () => { todos.push(1) })\n")
    write('lib/unused.js', 'const rows = []\nexports.add = (x) => { rows.push(x) }\n')
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  it('サーバーの印があるファイルが1つも無ければ、入れ物のファイルだけでは検出しない', () => {
    write('store.js', 'const rows = []\nexports.add = (x) => { rows.push(x) }\n')
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  it('除外は変わらない: node_modules の中のファイルは、読み込まれていても見ない', () => {
    write('node_modules/lib/store.js', 'const rows = []\nexports.add = (x) => { rows.push(x) }\n')
    write('server.js', "const express = require('express')\nrequire('./node_modules/lib/store')\nexpress().listen(1)\n")
    expect(scanDataUsage(dir).keepsInMemory).toEqual([])
  })

  it('サーバーの印のあるファイル自身の判定は、これまでどおり（server.js の22行目）', () => {
    write('server.js', REAL_SERVER_JS)
    expect(scanDataUsage(dir).keepsInMemory).toEqual([{ file: 'server.js', lines: [22] }])
  })
})

describe('見出し・見える形: 推定だけが理由のときは断定しない（検分で足した）', () => {
  it('★ メモリだけが理由の will-lose-data は memoryOnly で、ファイル書き込みもあれば付かない', () => {
    for (const t of STATELESS) {
      const onlyMemory = storageNeedFor({ usesDataLayer: false, writesFiles: false, keepsInMemory: true, target: t })
      expect(onlyMemory.kind === 'will-lose-data' && onlyMemory.memoryOnly).toBe(true)
      const both = storageNeedFor({ usesDataLayer: false, writesFiles: true, keepsInMemory: true, target: t })
      expect(both.kind === 'will-lose-data' && both.memoryOnly).toBeUndefined()
      const filesOnly = storageNeedFor({ usesDataLayer: false, writesFiles: true, keepsInMemory: false, target: t })
      expect(filesOnly.kind === 'will-lose-data' && filesOnly.memoryOnly).toBeUndefined()
    }
  })

  it('★ 推定だけのときの見出しは「消えるかもしれません」。ファイル書き込みがあれば、これまでどおり断定する', () => {
    expect(storageNoticeHeadline({ hasPlacement: false, warn: true, guess: true })).toBe('⚠️ データが消えるかもしれません')
    expect(storageNoticeHeadline({ hasPlacement: false, warn: true, guess: false })).toBe('⚠️ データが消えてしまいます')
    expect(storageNoticeHeadline({ hasPlacement: false, warn: true })).toBe('⚠️ データが消えてしまいます')
    expect(storageNoticeHeadline({ hasPlacement: true, warn: true, guess: true })).toContain('かもしれません')
    expect(storageNoticeHeadline({ hasPlacement: true, warn: true })).toBe('⚠️ 保存場所は用意済み・コードの書き直しが残っています')
    // 警告でなければ、推定かどうかは関係ない
    expect(storageNoticeHeadline({ hasPlacement: true, warn: false, guess: true })).toBe('💾 データの保存（用意済み）')
    expect(storageNoticeHeadline({ hasPlacement: false, warn: false, guess: true })).toBe('💾 データの保存について')
  })
})

describe('書き直せたかの確かめ: koto-data を使っていても、メモリが残っているのを黙らない（検分で足した）', () => {
  const left = [{ file: 'server.js', lines: [13] }]

  it('memorySitesNotWarned: koto-data を使っていて、警告にはしないメモリの場所を返す', () => {
    expect(memorySitesNotWarned({ usesDataLayer: true, writesFiles: [], keepsInMemory: left }, 'hanamii')).toEqual(left)
    // 警告の理由にしている側（koto-data を使っていない）には返さない（二重に言わない）
    expect(memorySitesNotWarned({ usesDataLayer: false, writesFiles: [], keepsInMemory: left }, 'hanamii')).toEqual([])
    // レンタルサーバは対象外
    expect(memorySitesNotWarned({ usesDataLayer: true, writesFiles: [], keepsInMemory: left }, 'sakura-rental')).toEqual([])
    expect(memorySitesNotWarned({ usesDataLayer: true, writesFiles: [] } as never, 'hanamii')).toEqual([])
  })

  it('★ ✅ の文は、メモリが残っている場所を名指しする（✅ の判断そのものは変えない）', () => {
    const scan = { usesDataLayer: true, writesFiles: [], memoryNotWarned: left }
    const line = rewriteCheckLine(scan)
    expect(line.startsWith('✅')).toBe(true)
    expect(line).toContain('server.js の 13行目')
    expect(line).toContain('メモリ')
    expect(line).toContain('キャッシュ')
    // 「書き直せています」と言い切らない
    expect(line).not.toContain('書き直せています')
    expect(rewriteCheckDone(scan)).toBe(true)
    // 画面に出る素のテキスト
    expect(line).not.toMatch(/\*\*|`/)
  })

  it('メモリが残っていなければ、✅ の文はこれまでと一字も変わらない', () => {
    const same = '✅ 書き直せています。ファイルへの書き込みは見つかりませんでした。'
    expect(rewriteCheckLine({ usesDataLayer: true, writesFiles: [] })).toBe(same)
    expect(rewriteCheckLine({ usesDataLayer: true, writesFiles: [], memoryNotWarned: [] })).toBe(same)
  })

  // ★ 文と判断は、同じ入力で食い違わない（呼び出し側の作法に頼らない・既存の約束の延長）
  it('★ rewriteCheckDone は、メモリの信号を含めても rewriteCheckLine の ✅ と必ず一致する', () => {
    const cases = [
      { usesDataLayer: true, writesFiles: [] },
      { usesDataLayer: true, writesFiles: [], keepsInMemory: [] },
      { usesDataLayer: true, writesFiles: [], keepsInMemory: left },                         // 警告側が残っている
      { usesDataLayer: false, writesFiles: [], keepsInMemory: left },
      { usesDataLayer: true, writesFiles: [], memoryNotWarned: left },                       // 名指しだけ
      { usesDataLayer: true, writesFiles: [], memoryNotWarned: left, truncated: true },
      { usesDataLayer: true, writesFiles: [{ file: 'a.js', lines: [3] }], keepsInMemory: left },
    ]
    for (const c of cases) expect(rewriteCheckDone(c), JSON.stringify(c)).toBe(rewriteCheckLine(c).startsWith('✅'))
  })

  it('★ 同じ入力で、文は ❌ なのに判断は ✅ になる食い違いが無い（警告側のメモリが残っている）', () => {
    const scan = { usesDataLayer: true, writesFiles: [], keepsInMemory: left }
    expect(rewriteCheckLine(scan)).toContain('❌')
    expect(rewriteCheckDone(scan)).toBe(false)
  })

  // ★ 検分の再現: AI が koto-data の読み込みを1行足しただけで、names.push は残っている
  it('★★ koto-data の読み込みを1行足しただけで push が残っているなら、確かめる文が場所を名指しする', () => {
    write('package.json', '{"name":"names-app"}')
    write('server.js', REAL_SERVER_JS.replace("const express = require('express');", "const express = require('express');\nconst { save } = require('./koto-data.cjs');"))
    const scan = scanDataUsage(dir)
    const facts = { usesDataLayer: scan.usedBy.length > 0, writesFiles: scan.writesFiles, keepsInMemory: scan.keepsInMemory }
    // 警告は出さない（仕様どおり）…
    expect(storageNeedForScan(facts, 'hanamii').kind).toBe('declared')
    expect(memorySitesFor(facts, 'hanamii')).toEqual([])
    // …が、確かめる文は、残っている場所を黙らない
    const result = {
      usesDataLayer: facts.usesDataLayer,
      writesFiles: scan.writesFiles,
      keepsInMemory: memorySitesFor(facts, 'hanamii'),
      memoryNotWarned: memorySitesNotWarned(facts, 'hanamii'),
    }
    const line = rewriteCheckLine(result)
    expect(line.startsWith('✅')).toBe(true)
    expect(line).toContain('server.js の 23行目')
  })

  it('別のファイルで koto-data を使っていても、メモリだけのファイルが残っているのを名指しする', () => {
    write('routes/contact.js', "const { save } = require('../koto-data.cjs')\nexports.post = async (req, res) => { await save('contacts', req.body); res.end() }\n")
    write('routes/board.js', 'const posts = []\nexports.post = (req, res) => { posts.push(req.body); res.end() }\n')
    write('server.js', "const express = require('express')\nrequire('./routes/contact')\nrequire('./routes/board')\nexpress().listen(1)\n")
    const scan = scanDataUsage(dir)
    const facts = { usesDataLayer: scan.usedBy.length > 0, writesFiles: scan.writesFiles, keepsInMemory: scan.keepsInMemory }
    const left2 = memorySitesNotWarned(facts, 'hanamii')
    expect(left2).toEqual([{ file: path.join('routes', 'board.js'), lines: [2] }])
    expect(rewriteCheckLine({ ...facts, keepsInMemory: [], memoryNotWarned: left2 })).toContain(`${path.join('routes', 'board.js')} の 2行目`)
  })
})

// ── 2026-10-01 検分2巡目で足した固定 ─────────────────────────────────────────
describe('検分2巡目: 宣言の行・clients の2つの意味', () => {
  it('★ 宣言の行に => があっても、宣言そのものを書き換えと数えない（否定の後読みを固定）', () => {
    // runsOnlyAtStartup は => を含む行を除外しないので、この形では後読みだけが誤検知を防いでいる
    const src = [
      "const http = require('http')",
      'let items = [1, 2].map(n => n * 2)',
      'http.createServer((q, s) => s.end(String(items))).listen(1)',
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })

  it('★ clients が顧客の一覧（配列に push）なら検出する（接続の Set だけを外す）', () => {
    const src = [
      "const express = require('express')",                                       // 1
      'const clients = []',                                                       // 2
      "express().post('/c', (req, res) => { clients.push({ name: req.body.name }); res.end() }).listen(1)", // 3
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([3])
  })

  it('★ clients が接続の Set（SSE）なら、これまでどおり検出しない', () => {
    const src = [
      "const express = require('express')",
      'const clients = new Set()',
      "express().get('/events', (req, res) => { clients.add(res) }).listen(1)",
    ].join('\n')
    expect(memoryKeepLines(src)).toEqual([])
  })
})
