/**
 * Vite 的 `?raw` 导入（vitest 里用它读迁移 SQL）。
 * api 包本身不依赖 vite / @types/node，这里只补最小的类型声明，
 * 免得为了一个测试把整套 node 类型拉进 Workers 的 typecheck。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
