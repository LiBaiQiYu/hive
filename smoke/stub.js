// wrangler 的 d1 命令需要一个 entry-point 才能解析配置；这个桩不参与任何测试逻辑。
export default {
  fetch() {
    return new Response('hive smoke stub', { status: 200 });
  },
};
