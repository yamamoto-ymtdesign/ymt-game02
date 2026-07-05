#!/usr/bin/env node
// index.html と css/js を1枚の自己完結HTMLに束ねる。
// 出力はコメント・外部参照なしなので、ブラウザで直接開いても Artifact でもそのまま動く。
//   node tools/build-standalone.mjs  → dist/texteleven-standalone.html

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), "utf-8");

const css = read("css/style.css");
const jsFiles = ["js/teams-data.js", "js/md.js", "js/engine.js", "js/pitch.js", "js/app.js"];
const scripts = jsFiles.map((f) => `<script>\n${read(f)}\n</script>`).join("\n");

const html = read("index.html");
const body = html.match(/<header>[\s\S]*<\/footer>/)[0];

const out = `<title>テキストイレブン — 戦略テキストで戦うサッカーシミュレーション</title>
<style>
${css}
</style>
${body}
${scripts}
`;

const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "texteleven-standalone.html"), out, "utf-8");
console.log(`dist/texteleven-standalone.html を出力（${(out.length / 1024).toFixed(0)} KB）`);
