import { defineConfig } from 'vitest/config';

/**
 * 单测配置。
 *
 * 唯一需要显式处理的是 `node:sqlite`：Vite 5 的内置模块表里没有它
 * （Node 22 才加进标准库），会先去掉 `node:` 前缀，再把 `sqlite` 当成
 * npm 包去解析并报「Failed to load url sqlite」。
 *
 * 用一个小插件把它直接标成外部模块，交给 Node 原生 import 去加载。
 * 只在 `node:` 前缀上动手，不影响其它内置模块的正常解析。
 */
const NODE_BUILTIN_ONLY = new Set(['node:sqlite', 'sqlite']);

export default defineConfig({
  plugins: [
    {
      name: 'hive:node-builtin-externals',
      enforce: 'pre',
      resolveId(id) {
        if (NODE_BUILTIN_ONLY.has(id)) return { id, external: true };
        return null;
      },
    },
  ],
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
});
