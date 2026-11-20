# HIVE · UI 视觉规范与整改记录（2026-11）

> 日期：2026-11-19
> 范围：`apps/web`
> 关联提交：`fe5bd0a feat(ui): 视觉规范一致性收口`
> 配套文档：`docs/UI.md`（信息架构与产品语义）
> 审计快照与走查截图保存在 Open Design 项目工作区（`patches/backups/`、`qa/`），不随仓库提交

## 0. 两份文档的分工

| 文档 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `docs/UI.md` | 信息架构、路由、产品语义、状态到界面的映射 | 具体色值、字号、圆角、组件视觉 |
| 本文件 | 视觉令牌、组件规范、交互与无障碍底线、整改记录 | 业务规则、接口字段、排期 |

改动视觉前先确认本文件；改导航或页面职责前先确认 `docs/UI.md`。

---

## 1. 初始审计结论

审计对象为 `apps/web` 的 43 个 Vue 文件与约 7,845 行 CSS，视觉一致性总分 **2.8 / 5**。

视觉方向本身是成立的：近黑底、赤金描边、衬线标题、战情室气质。问题不在审美，在**约束**：

| 根因 | 审计时的表现 |
| --- | --- |
| 主色有四个真值 | `docs/UI.md` 写紫 `#6C5CE7`，`styles.css` 的 `--brand` 是 `#7b6cf0`，Naive 主题是赤金，浅色又改成 Dota 红 |
| 两套按钮并存 | 21 处手写 `.btn` 与 85 处 `NButton`，圆角 6 / 8、默认底、主行动色均不一致 |
| 浅色是补丁 | `styles-theme.css` 646 行中混有配色覆盖与布局修复 |
| 令牌缺口 | 只有 `--radius` 一个尺寸令牌；字号 19 档、圆角 11 档、`:root` 外裸色值约 129 处 |
| 强调色过载 | 金色系声明 118 次，同时承担链接、数字、标题、悬停、边框、焦点环 |

### 1.1 方向决策

1. 保留「赤金主导」的战情室方向；
2. 紫色降级为信息色（`--info`，用于阵容已发布 / 候补等状态）；
3. 红色收紧为危险色（`--danger`，用于错误、Dire、失败）；
4. 全站只保留一个强调色、一个信息色、一个危险色、一个成功色。

---

## 2. 初始建议与落地情况

### 2.1 P0（阻塞观感与维护）

| # | 初始建议 | 状态 | 落点 / 说明 |
| --- | --- | --- | --- |
| 1 | 主色单一来源，新建 `tokens.css` | 已落地 | `apps/web/src/tokens.css` 只放 `:root` 与 `[data-theme='light']` 变量；其余文件引用变量 |
| 2 | 把概念稿标成概念稿 | 已落地 | `docs/UI.md` 顶部状态横幅，明确其描述的是早期概念而非现行实现 |
| 3 | 删除失效的浅色变量 | 已落地 | 删除 `styles.css:37–41` 的旧浅色块，避免与 `styles-theme.css` 互相覆盖 |
| 4 | 按钮收敛：一个主行动 | 已落地 | 主行动统一为赤金实色 + 深墨字（8.7:1）；`.btn` 与 `NButton` 统一 36px / 8px / 13px / 0.02em |
| 5 | 首屏不闪、系统控件跟随 | 已落地 | `public/theme-boot.js` 在首帧前套用主题；`<meta name="color-scheme">` 与 `theme.ts` 的 `syncMeta` 同步 |

### 2.2 P1 / P2（一致性与长期维护）

| # | 初始建议 | 状态 | 落点 / 说明 |
| --- | --- | --- | --- |
| 6 | 补 `--font-body`，决定衬线来源 | **未完成** | 仍无 `--font-body`；`styles-admin.css` 里存在 `var(--body, inherit)` 悬空引用。列为待办 |
| 7 | 状态色与文档对齐 | 已落地 | `MATCH_STATUS_LABEL` 补齐 `IN_PROGRESS` / `VOID`；新增 `StatusPill` 统一事件 / 比赛状态 |
| 8 | 把 `.table` 从 `styles-admin.css` 抽到基础层 | 已落地 | `.table` 基础样式移入 `styles.css`，后台只保留扩展 |
| 9 | 给「强调」建语义类 | 部分落地 | 新增 `StatusPill` / `.pill-*` 与令牌别名；未新增 `--data-strong`，关键数字仍用 `--accent-soft` |
| 10 | 用 `color-mix` 消灭裸 `rgba` | 部分落地 | 关键交互、浅色金色残留已改为 `color-mix(var(--accent))`；全站仍有约 500 处 `rgba`，多为阴影与叠加，建议渐进替换 |
| 11 | 字号与圆角收敛 | 已落地 | 半档字号（10.5 / 11.5 / 12.5 / 13.5）已消除；圆角 9px → 8px；移动端触控目标 44px |
| 12 | 加一条自动化底线 | 已有 | `tsc` / `vitest` / `scripts/check-vue-templates.mjs` / `vite build` 作为提交前四件套 |

### 2.3 审计之外的追加整改

审计完成后，在走查中又补了三项：

| 问题 | 处理 |
| --- | --- |
| 成员表 13 行 × 2 个主色按钮，层级过重 | 「设为管理员」降为默认描边，「重置密码」降为 `quaternary` 文本按钮；每行最多一个强调动作 |
| 管理员邮箱是占位地址，密码找回不可用 | 新增 `lib/email.ts` 判断占位域名；顶部提醒条与账号设置明确警示，并禁止对占位地址做「我确认能收到信」 |
| 筛选胶囊边框缺失、分隔竖线穿出胶囊 | 停止复用 Naive 连体分段控件的外观：隐藏 `splitor` 与 `state-border`，每个按钮自绘完整 1px 描边与 6px 圆角 |

---

## 3. 现行视觉规范

### 3.1 设计语言

- **深色为默认**：近黑画布 + 赤金信号色 + 衬线标题，整体是战情室 / 赛事台账气质。
- **浅色是同一套语言的反相**：浅灰画布 + 白卡，强调色切到 Dota 红，标题用深藏青。
- **金色只做信号，不做大面积装饰底色**；每屏强调色可见使用不超过 2 处。
- 字体角色固定：衬线只用于标题与数字，正文永远用系统无衬线。

### 3.2 颜色令牌

深色（`:root`）：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#0a0c10` | 页面底色 |
| `--bg-2` | `#0e1116` | 次级底色 |
| `--surface` | `#151a24` | 卡片 / 面板 |
| `--surface-2` | `#1c2230` | 卡片内嵌层 |
| `--accent` | `#d4ad33` | 主行动、焦点、关键信号 |
| `--accent-soft` | `#f0d68d` | 强调文字、关键数字 |
| `--info` | `oklch(66% 0.14 285)` | 信息状态（已发布 / 候补） |
| `--danger` | `#c25454` | 错误、失败、Dire |
| `--success` | `#63bb6c` | 成功、Radiant |
| `--text` | `#efece3` | 正文 |
| `--muted` | `#a9b0c0` | 次要文字 |
| `--line` | `accent 22%` | 常规分隔线 |
| `--line-strong` | `accent 55%` | 可交互描边 |
| `--line-faint` | `rgba(255,255,255,.04)` | 表格行分隔等极淡中性线 |
| `--line-dashed` | `rgba(255,255,255,.06)` | 虚线分隔 |
| `--text-strong` | `#f2eee2` | 衬线标题 / 大数字（比正文亮一档） |
| `--on-accent` | `#17130a` | 主行动填充上的字（约 8.7:1） |
| `--danger-text` | `#e6a6a6` | 错误条文字（danger 提亮到可读） |
| `--veil` | `rgba(10,12,16,.86)` | 顶栏 / 半透明浮层底 |
| `--wash` | `rgba(255,255,255,.015)` | 内嵌块底色 |
| `--wash-strong` | `rgba(255,255,255,.06)` | 进度条槽 / 骨架条 |
| `--card-sheen` | `rgba(255,255,255,.025)` | 卡面顶端柔光 |
| `--amber` | `#eab03c` | 临近 / 待处理 |
| `--radius-sm` | `4px` | 角标 / 小标签 |
| `--radius-chip` | `6px` | 筛选胶囊 / 导航项 |
| `--radius-control` | `8px` | 按钮 / 输入框 |
| `--radius` | `10px` | 卡片默认圆角 |
| `--radius-overlay` | `12px` | 弹层 / 浮层 |
| `--radius-pill` | `999px` | 状态胶囊 |
| `--font-body` | 系统无衬线栈 | 正文 / 控件 / 表格 |
| `--display` | Trajan / Cinzel / 宋体栈 | 标题与大数字 |
| `--hero-*` | 见 `tokens.css` | 首页英雄区（原画遮罩上的排版） |
| `--shadow-card` | `0 10px 28px rgba(0,0,0,.28)` | 卡片阴影 |
| `--shadow-pop` | `0 16px 40px rgba(0,0,0,.42)` | 弹层阴影 |

浅色（`[data-theme='light']`）：

| 令牌 | 值 |
| --- | --- |
| `--bg` | `#f4f6fb` |
| `--bg-2` | `#eaeef7` |
| `--surface` | `#ffffff` |
| `--surface-2` | `#f6f8fd` |
| `--accent` | `#b3261e` |
| `--accent-soft` | `#8e1b15` |
| `--info` | `#3b4a66` |
| `--danger` | `#b3261e` |
| `--success` | `#1f8f52` |
| `--text` | `#1b2033` |
| `--muted` | `#5b6478` |
| `--line` | `accent 16%` |
| `--line-strong` | `accent 45%` |
| `--amber` | `#a8620a` |

别名（只做兼容，不新增语义）：

```css
--gold: var(--accent);
--gold-2: var(--accent-soft);
--brand: var(--info);
--radiant: var(--success);
--dire: var(--danger);
```

规则：

1. 颜色只在 `tokens.css` 定义，组件只能 `var()` 引用。
2. 需要透明度时用 `color-mix(in oklab, var(--token) N%, transparent)`，不要手写同色系 `rgba`。
3. 语义色不能互换：`--danger` 不用于营销强调，`--info` 不用于主行动。
4. 浅色主题优先覆盖令牌；仍保留的少量组件级覆盖（按钮渐变等）必须在 `styles-theme.css` 集中管理，不得散落到页面。

### 3.3 字体与字号

| 角色 | 字体栈 | 用法 |
| --- | --- | --- |
| 显示 / 标题 | `'Trajan Pro', 'Cinzel', Georgia, 'Songti SC', 'Noto Serif SC', serif`（`--display`） | 页面标题、卡片标题、大数字 |
| 正文 / UI | `-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif`（`--font-body`） | 正文、按钮、表格、表单 |
| 数字 | 不单独换字体，统一 `font-variant-numeric: tabular-nums` | 表格、统计、比分、天梯分 |

**字体一律走令牌**：`font-family: var(--font-body)` / `var(--display)`。CSS 里不再出现硬编码的
sans 字体栈——散落的字体栈会让「正文到底用哪套」变成拼运气，改一处字体要满仓库找。

常用字号：

| 档位 | 用途 | 行高 / 字距 |
| --- | --- | --- |
| 10–11px | 角标、元信息、表头 | 大写时 `0.12em–0.3em` |
| 12px | 表格次要信息、辅助说明 | 1.5 |
| 13px | 控件、表格正文、按钮 | 1.4–1.5；按钮 `0.02em` |
| 14px | 页面正文基准 | 1.7 |
| 15px | 卡片内的强调正文 / 副标题 | 1.7–1.9 |
| 16px | 卡片标题 | 1.3–1.4；`0.1em` |
| 17px | 赛事名 / 玩家卡名 / 评分预览 | 1.4；`0.06em` |
| 18px | 页面区块标题 | 1.2；`0.12em` |
| 20px | 玩家档案统计值 | 1.1 |
| 26px | 统计数字 / 记录值 | 1；等宽数字 |
| 56px | 评分大数字（我的页） | 1 |
| `clamp(38px, 6vw, 62px)` | Hero 主标题 | 1.05；`0.12em` |

规则：

- 禁止再引入 10.5 / 11.5 / 12.5 / 13.5 这类半档字号。
- 正文不使用 `text-align: justify`。
- 全大写文字必须带正向字距（≥ `0.12em`）；衬线标题保留 `0.1em–0.12em` 的碑刻感字距。
- 正文行宽控制在约 34–40em。

### 3.4 圆角、描边与阴影

| 场景 | 圆角 | 令牌 |
| --- | --- | --- |
| 角标 / 小标签 | 4px | `--radius-sm` |
| 筛选胶囊 / 导航项 | 6px | `--radius-chip` |
| 按钮 / 输入框 | 8px | `--radius-control` |
| 卡片 / 面板 | 10px | `--radius` |
| 弹层 / 浮层 | 12px | `--radius-overlay` |
| 状态胶囊 / 进度条 | 999px | `--radius-pill` |

- 圆角也走令牌：新代码禁止再写字面量 `6px / 8px / 10px / 999px`（`styles-skins.css` 的皮肤参数除外）。
- 描边统一 1px；可交互元素用 `--line-strong`，静态分隔用 `--line`，表格行与极淡分隔用 `--line-faint`。
- 阴影只用于真正的浮层与卡片层级，不给普通分区加阴影。
- 禁止「圆角卡片 + 左侧彩色竖条」的装饰写法。

### 3.5 布局与响应式

- 内容容器：`min(1180px, 100% - 40px)`，水平居中。
- 主要断点：1120 / 900 / 760 / 720 / 560px；局部组件另有 640 / 620 / 520px 等就近断点。
- 移动端（≤560px）：表格保持横向滚动，不挤压成竖排；可点击目标不小于 44×44px；正文不小于 12px。
- 页面结构：`PageBack` → `.section-head`（标题 + 页面级动作）→ 工具条 → 内容 → 空态 / 分页。
- 同一页面只允许一个主行动；行内操作降级为描边或文本按钮。

### 3.6 按钮

两套实现，职责不同，视觉必须对齐：

| 体系 | 用在哪 | 规格 |
| --- | --- | --- |
| `.btn` | 链接语义的动作（`RouterLink`、下载、跳转） | 高 36px；圆角 8px；字号 13px；字距 0.02em；1px 描边 |
| `NButton` | 需要 loading / disabled / 异步反馈的动作 | 36px（small 30px）；圆角 8px；与 `.btn` 同高同字 |

层级：

1. **主行动**：`.btn-primary` 或 `NButton type="primary"`，每屏一个。
   - 深色：`--accent` 填充 + `#17130a` 深墨字（约 8.7:1）。
   - 浅色：Dota 红渐变 + 白字（浅色主题的既定决策）。
2. **次行动**：默认 `NButton` / `.btn`，透明底 + `--line-strong` 描边。
3. **弱行动**：`.btn-ghost` / `NButton quaternary`，无填充、次要文字色。

禁止：

- 一行里出现两个主色按钮；
- 用 `.btn` 承担需要 loading 的异步操作；
- 给按钮再加自定义渐变或第二套圆角。

### 3.7 状态徽标

统一使用 `.pill` + `StatusPill`，不要在各页面手写状态颜色。

| 状态 | 组件 / 类 | 色调 |
| --- | --- | --- |
| 报名中 | `StatusPill status="REGISTRATION_OPEN"` | `--success` |
| 报名截止 | `REGISTRATION_CLOSED` | `--amber` |
| 已发布 | `PUBLISHED`（赛事 / 比赛） | `--info` |
| 进行中 | 比赛 `IN_PROGRESS` | `--success` |
| 已取消 / 已作废 | `CANCELLED` / `VOID` | `--muted` |

规则：状态色不能只靠颜色区分，文案必须同时变化；中文标签统一从 `lib/api.ts` 的 `STATUS_LABEL` / `MATCH_STATUS_LABEL` 读取。

### 3.8 表格

- 基础 `.table` 在 `styles.css`，后台扩展在 `styles-admin.css`。
- 表头：11px、大写、`0.16em` 字距、`--muted`、底部 `--line` 分隔。
- 单元格：13px，内边距 `9px 10px`，行分隔用极淡的 `rgba(255,255,255,.04)`（浅色主题另有覆盖）。
- 数字列：加 `.num`，右对齐 + `tabular-nums`。
- 可排序列：必须用 `SortableTh`，带 `aria-sort`、`tabindex="0"`，支持 Enter / Space；排序箭头只在当前列出现。
- 行内操作：默认按钮 + 文本按钮组合；不要每行重复主色。
- 列多时用 `.table-wrap` 横向滚动，不缩字号硬塞。

### 3.9 卡片与统计

- `.card`：`--surface` 底、1px `--line`、10px 圆角、内边距 18–20px。
- `.card-title`：衬线 16px、`--accent-soft`、右侧渐隐分隔线。
- 统计卡统一用 `StatCard`（首页 / 后台 / 队列），不要各页重写 `.admin-stat`。
- 数字用 `tabular-nums`；空值用 `—`，不要编造 0。

### 3.10 加载、空态与错误

- 加载：列表页统一用 `SkeletonRows`，禁止只写「加载中…」。
- 空态：一句说明 + 一个下一步动作（如「去报名」「去创建赛事」）。
- 错误：行内 `.alert` 或 toast；错误文案必须包含可执行的下一步。
- 异步动作：按钮进入 loading，失败后恢复并提示，不允许静默失败。

### 3.11 筛选胶囊

- 成员筛选与赛事筛选使用独立胶囊：每个按钮自绘 1px 描边 + 6px 圆角。
- 不使用 Naive 连体分段控件的外观：隐藏 `.n-radio-group__splitor` 与 `.n-radio-button__state-border`。
- 选中 / hover / 键盘聚焦：`border-color: var(--n-button-border-color-active)`；键盘聚焦额外加 2px 柔和 focus ring。
- 计数跟在标签后，用 `.vf-count`（`tabular-nums`、60% 透明度）。

### 3.12 邮箱与占位地址

- 密码找回依赖真实收件邮箱，不是登录用户名。
- `lib/email.ts` 的 `isPlaceholderEmail` 与 API 端 `notify.ts` 保持同一份域名名单（`hive.local` / `hive.test` / `example.com` / `example.org` / `localhost`）。
- 占位地址：
  - 顶部提醒条显示「这是占位地址，收不到重置邮件」，CTA 为「去改邮箱」；
  - 隐藏「我确认能收到信」，避免假确认；
  - 账号设置页邮箱输入框下方显示红色警示。
- 新建账号 / 种子数据禁止再写入占位域名。

### 3.13 主题与首屏

- 默认深色；无显式选择时跟随系统 `prefers-color-scheme`。
- `public/theme-boot.js` 在首帧前读取 `localStorage['hive-theme']` 并写入 `data-theme`，避免闪白/闪深。
- `theme.ts` 同步 `<meta name="color-scheme">` 与 `theme-color`，让浏览器原生控件跟随主题。
- 新增主题相关样式优先改令牌；组件级覆盖只能进 `styles-theme.css`。

### 3.14 无障碍与交互底线

- 正文对比度 ≥ 4.5:1；大字号 ≥ 3:1。
- 所有可点击元素有 `:focus-visible` 可见焦点环，不能只靠 hover。
- 图标按钮必须有 `aria-label`；纯装饰图标 `aria-hidden="true"`。
- 排序、展开行等自定义交互必须可键盘操作。
- 移动端触控目标 ≥ 44px。
- `prefers-reduced-motion: reduce` 下关闭位移动画与自动滚动。

---

## 4. 新增组件清单

| 组件 | 文件 | 用途 |
| --- | --- | --- |
| `StatusPill` | `src/components/StatusPill.vue` | 事件 / 比赛状态徽标，统一文案与色调 |
| `SortableTh` | `src/components/SortableTh.vue` | 可排序表头，含 `aria-sort` 与键盘支持 |
| `SkeletonRows` | `src/components/SkeletonRows.vue` | 列表加载骨架，替代纯文字「加载中」 |
| `StatCard` | `src/components/StatCard.vue` | 首页 / 后台 / 队列统一统计卡 |
| `email` | `src/lib/email.ts` | 占位邮箱判断，前后端同规则 |
| `tokens` | `src/tokens.css` | 唯一颜色令牌层 |
| `theme-boot` | `public/theme-boot.js` | 首屏主题脚本（CSP 安全） |

---

## 5. 验收与回滚

### 5.1 提交前四件套

```bash
node_modules/typescript/bin/tsc -p tsconfig.json --pretty false
node_modules/vitest/vitest.mjs run
node scripts/check-vue-templates.mjs
cd apps/web && node node_modules/vite/bin/vite.js build
```

当前结果：`tsc` 0；`vitest` 24 文件 227 测试；模板体检 47 文件；`vite build` 通过（仅既有 naive chunk 761 kB 警告）。

### 5.2 视觉走查

- 13 条主路由（首页 / 赛事 / 排行榜 / 战绩 / 我的 / 账号设置 + 7 个后台页）登录态走查：0 控制台错误。
- 深浅两主题截图保存在 Open Design 工作区的 `qa/`。
- 390px 移动端检查横幅换行、筛选胶囊与触控尺寸。

### 5.3 回滚

仓库内直接回滚：

```bash
git revert fe5bd0a
```

审计过程中的逐文件快照保存在 Open Design 工作区，按批次取用：

| 批次 | 快照 |
| --- | --- |
| P0 基础 | `patches/backups/20261119-154705/` |
| 令牌层 | `patches/backups/20261119-160833-tokens/` |
| 主行动赤金 | `patches/backups/20261119-161233-gold/` |
| P1 组件 | `patches/backups/20261119-164218-p1/` |
| 表格键盘 | `patches/backups/20261119-165109-tables/` |
| 令牌收口 | `patches/backups/20261119-170337-tokens-post/` |
| Item 5 | `patches/backups/20261119-170857-item5/` |
| P2 第一批 | `patches/backups/20261119-172006-p2/` |
| P2 第二批 | `patches/backups/20261119-173555-p2b-post/` |
| 邮箱守卫 | `patches/backups/20261119-180000-email/` |
| 筛选边框 | `patches/backups/20261119-190000-filter/` |

同在工作区的 `patches/apply-p0-safe.ps1` 支持 dry-run、`-Apply` 与 `-Restore latest`。

---

## 6. 待办与已知遗留

1. **管理员邮箱仍是占位地址**：需要本人在「账号设置」改成真实邮箱；UI 已提示并阻止假确认。
2. ~~**`--font-body` 未补**~~ **已修（2026-11-20）**：`tokens.css` 补上 `--font-body` 与 `--display`，
   `styles-admin.css` 的 `var(--body, inherit)` 悬空引用改为 `var(--font-body)`；
   另外三处硬编码的 sans 字体栈（含 `lib/ui.ts` 之外的 CSS）也统一成该令牌。
3. **裸 `rgba` 未清零**：全站仍有约 385 处，集中在 `styles-skins.css`（卡面材质，291 处）与
   `styles-frame-fx.css`（边框特效，194 处）——这两块是**视觉特效的调参数据，不是 UI 配色**，
   按「特效色不进令牌」保留；UI 层（styles / theme / admin / ui / me / player / hero）已清零到
   仅剩阴影与极淡中性叠加。
4. ~~**深色 body 旧紫色径向光晕**~~ **已修（2026-11-20）**：身体背景与通用 `.hero` 的两层径向光
   改为 `color-mix(var(--accent))` 与 `color-mix(var(--danger))` 微光；
   `.powered-badge` 的旧品牌紫（`rgba(123,108,240,…)`）改为 `--info`，与「紫色只做 info」一致。
5. **字号离群值已收敛**：`19px → 18px`（后台评分预览）、`24px → 26px`（我的页记录值）；
   `56px`（评分大数字）与 `clamp()` 的 Hero 标题保留——它们属于「大数字」档，不是正文离群。
6. **浅色主按钮仍用组件级红色渐变覆盖**：属于既定的 Dota 红方案；若要彻底令牌化，可引入
   `--accent-contrast` 与 `--accent-gradient` 后再迁移。目前该覆盖集中在 `styles-theme.css`，
   字色已改读 `--on-accent`（深色 #17130a / 浅色 #fff）。
7. **`.skeleton-bar` 曾引用不存在的 `--fg`**（2026-11-20 修）：`var()` 解析失败会让整条
   `background` 声明失效，骨架屏实际是透明的。改为 `--wash-strong`。同类问题排查办法：
   跑一次「所有 `var(--x)` 是否都有定义」的脚本（`--rx/--ry/--mx/--my/--pct` 这类由 Vue 内联写的
   动态变量属正常例外）。

---

## 7. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-19 | 完成 P0 / P1 / P2 三批整改；新增令牌层与四个共享组件；成员表按钮降级；占位邮箱守卫；筛选胶囊边框修复；提交 `fe5bd0a` |
| 2026-11-19 | `fe5bd0a` 被 `dedbe8f` 回滚，生产回到 `0d924826`（代码 `116d663`） |
| 2026-11-20 | 按本文档二次落地（`5763643` + 本轮）：令牌层真正成为唯一颜色真源（`styles.css` / `styles-theme.css` 不再定义颜色）；补 `--font-body` / `--radius-chip` / `--on-accent` / `--line-faint` / `--veil` / `--wash` / Hero 专用令牌；浅色与后台全部 `rgba` 换成 `color-mix`；字号与圆角收敛；`.skeleton-bar` 修 `--fg` 悬空引用；后台赛事状态改用 `StatusPill`；成员表行内按钮统一降级为文本按钮 |
