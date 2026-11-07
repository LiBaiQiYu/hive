#!/usr/bin/env node
/**
 * 模板体检：没有 vue-tsc（会拖进一整套 TS 依赖），但 Vue 的模板错误
 * ——写错的指令、未定义的绑定、拼错的组件名——只有在 build 或运行时才炸。
 *
 * 这里直接调 @vue/compiler-sfc 把每个 .vue 的 <script setup> + <template>
 * 编一遍（与 vite 用的同一个编译器），能提前抓到：
 *   · 模板语法错误（未闭合标签、非法的 v-for 等）
 *   · 模板里引用了不存在的 setup 绑定（编译产物里会退化成 _ctx.xxx）
 *
 * 用法：node scripts/check-vue-templates.mjs [文件...]   不带参数则检查 apps/web/src 全量
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const pnpmDir = join(root, 'node_modules', '.pnpm');

const pkg = readdirSync(pnpmDir).find((entry) => entry.startsWith('@vue+compiler-sfc@'));
if (!pkg) {
  console.error('找不到 @vue/compiler-sfc（先 pnpm install）');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { parse, compileScript, compileTemplate } = require(
  join(pnpmDir, pkg, 'node_modules', '@vue', 'compiler-sfc', 'dist', 'compiler-sfc.cjs.js'),
);

/** 模板里的全局属性，出现这些不算"未定义" */
const GLOBALS = new Set(['$route', '$router', '$t', '$slots', '$attrs', '$props', '$emit', '$refs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

const targets = process.argv.slice(2).map((p) => resolve(p));
const files = targets.length > 0 ? targets : walk(join(root, 'apps', 'web', 'src'));

let failures = 0;
for (const file of files) {
  const relative = file.slice(root.length + 1);
  const source = readFileSync(file, 'utf8');
  const { descriptor, errors } = parse(source, { filename: file });
  if (errors.length > 0) {
    failures += 1;
    console.log(`✗ ${relative}\n    ${errors.map((e) => e.message).join('\n    ')}`);
    continue;
  }
  if (!descriptor.template) continue;

  const id = basename(file);
  let bindings = {};
  try {
    bindings = compileScript(descriptor, { id }).bindings;
  } catch (err) {
    failures += 1;
    console.log(`✗ ${relative} <script setup>\n    ${err.message}`);
    continue;
  }

  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: file,
    id,
    compilerOptions: { bindingMetadata: bindings },
  });
  if (compiled.errors.length > 0) {
    failures += 1;
    console.log(
      `✗ ${relative} <template>\n    ${compiled.errors.map((e) => e.message || String(e)).join('\n    ')}`,
    );
    continue;
  }

  const unknown = new Set();
  for (const match of compiled.code.matchAll(/_ctx\.([A-Za-z0-9_$]+)/g)) {
    if (!GLOBALS.has(match[1])) unknown.add(match[1]);
  }
  if (unknown.size > 0) {
    failures += 1;
    console.log(`✗ ${relative} 模板引用了不存在的绑定：${[...unknown].join(', ')}`);
  }
}

if (failures === 0) {
  console.log(`✓ 模板体检通过（${files.length} 个文件）`);
} else {
  console.log(`\n${failures} 个文件有问题`);
}
process.exit(failures === 0 ? 0 : 1);
