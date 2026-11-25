/**
 * Node 自建部署的构建脚本。
 *
 * 产出两个可执行入口（esbuild 打包成单文件，运行时不依赖 node_modules）：
 *   · dist/server.mjs   ── HTTP 服务 + 定时任务
 *   · dist/migrate.mjs  ── 迁移命令行（容器启动前先跑一次）
 *
 * 为什么用 esbuild 而不是 tsc：
 *   1. 要把 workspace 包（@hive/shared 等）里的 TS 一起打进来，tsc 得先产出
 *      .js + 改 import 路径，麻烦且容易错；
 *   2. 产物体积只有几百 KB，容器镜像里不用带 node_modules。
 *
 * 注意：`node:sqlite` 这类内置模块标成 external（交给 Node 原生加载），
 * 但 **nodemailer 要打进来** —— 否则容器里还得 `npm install` 一次，
 * 等于部署要求服务器能访问 npm registry（国内经常卡在这里）。
 * 打进来之后产物 ~900KB，换来"服务器只认 Docker 镜像，不需要任何包管理器"。
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // 只把 Node 内置模块留给运行时；其余（含 nodemailer）全部打进产物
  external: ['node:*'],
  // ESM 产物里 __dirname / require 这类 CommonJS 惯用法要补垫片
  banner: {
    js: [
      "import { createRequire as __hiveCreateRequire } from 'node:module';",
      "import { fileURLToPath as __hiveFileURLToPath } from 'node:url';",
      "import { dirname as __hiveDirname } from 'node:path';",
      'const require = __hiveCreateRequire(import.meta.url);',
      'const __filename = __hiveFileURLToPath(import.meta.url);',
      'const __dirname = __hiveDirname(__filename);',
    ].join(' '),
  },
  logLevel: 'info',
};

rmSync('dist', { recursive: true, force: true });

await Promise.all([
  build({ ...shared, entryPoints: ['src/server/index.ts'], outfile: 'dist/server.mjs' }),
  build({ ...shared, entryPoints: ['src/server/migrate-cli.ts'], outfile: 'dist/migrate.mjs' }),
]);

console.log('[build] dist/server.mjs, dist/migrate.mjs');
