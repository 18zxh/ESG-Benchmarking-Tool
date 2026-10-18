---
name: "MSCI ESG 评级知识库"
description: "简洁工作界面：白底、森林绿、细分隔线与系统中文字体。"
colors:
  paper: "#ffffff"
  surface: "#ffffff"
  surface-2: "#f7f8f8"
  ink: "#242b28"
  ink-2: "#39463e"
  muted: "#626d66"
  faint: "#626d66"
  line: "#e6e8e7"
  line-strong: "#b8c7bc"
  navy: "#344b40"
  navy-ink: "#293c33"
  env: "#2e6b58"
  env-soft: "#e8f0ec"
  soc: "#79582d"
  soc-soft: "#f7f3ec"
  gov: "#4f6158"
  gov-soft: "#eff4f0"
  nav-active: "#edf3ee"
  nav-active-hover: "#e5eee7"
  row-hover: "#f0f4f1"
  source-warning-bg: "#f4ede3"
  source-warning-ink: "#5a4227"
  source-warning-line: "#dfd1bc"
  workbench-error-bg: "#fff2ef"
  workbench-error-ink: "#8b3027"
  export-error: "#8b3030"
  search-match: "#fde68a"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: "clamp(1.75rem, 1.25rem + 1.8vw, 2.25rem)"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: "2rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: "16px"
    lineHeight: 1.65
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: ".875rem"
    fontWeight: 600
    lineHeight: 1.65
  mono:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "12px"
rounded:
  radius-sm: "8px"
  radius: "12px"
  badge: "4px"
  pill: "999px"
spacing:
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "28": "28px"
  "32": "32px"
  "40": "40px"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface}"
    rounded: "{rounded.radius-sm}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.navy-ink}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-sm}"
    padding: "10px 16px"
  button-secondary-hover:
    textColor: "{colors.navy}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.navy}"
    padding: "8px 0"
  input-workbench:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-sm}"
    padding: "10px 12px"
    width: "100%"
  nav-link:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.radius-sm}"
    padding: "10px 8px"
  nav-link-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.navy}"
  chip-filter:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
  chip-filter-selected:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface}"
  result-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "20px 0"
  card-knowledge:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "24px 0"
  stage-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "12px 6px"
  stage-tab-selected:
    textColor: "{colors.navy}"
  report-upload:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.radius}"
    padding: "28px"
  report-upload-hover:
    backgroundColor: "{colors.row-hover}"
---

# Design System: MSCI ESG 评级知识库

## Overview

**Creative North Star: "简洁工作界面"**

白色承载阅读与操作，森林绿标记当前步骤、来源链接和主要动作。知识阅读、查询与三页工作台共用系统中文字体、细分隔线和留白；内容层级由标题、字号及间距形成。

界面采用扁平层次，列表与表格便于逐项核对。浅灰和浅绿用于容器与选中状态，警告、错误和支柱分类保留自己的语义颜色。现有功能与资料内容不由本文件重新定义。

记录日期为 2026-10-06。令牌与状态依据 [全站样式](site/styles.css) 和现有组件代码提取；未访问真实浏览器，响应布局与参考风格的视觉相似度尚未验收。扩展信息与七个独立样式片段见 [.impeccable/design.json](.impeccable/design.json)。

**Key Characteristics:**

- 白底、森林绿操作色、灰色分隔线。
- 系统中文字体，英文与来源信息采用次级层次。
- 扁平列表与表格，主要操作和表单保留清晰的操作面积。
- 选中状态与键盘焦点均有独立标记。

## Colors

前面的令牌是颜色规范；沿用已有 CSS 名称，历史名称 navy 在当前实现中表示森林绿。

### Primary

森林绿用于主要按钮、链接、当前导航、三步导航底线和焦点；navy-ink 用于较深的悬停状态。nav-active、nav-active-hover 和 row-hover 分别记录现有浅绿状态背景。

### Secondary

env／soc／gov 及各自 soft 色只区分环境、社会、治理。source-warning、workbench-error、export-error 和 search-match 各组承载来源警告、工作台错误、导出错误及搜索命中；这些语义色不替代主要操作色。

### Neutral

paper 与 surface 为页面及白色表面；surface-2 为浅灰容器与表头。ink、ink-2、muted／faint 依次用于正文、辅助正文和说明；line 为普通分隔线，line-strong 为表单与结构边界。muted 与 faint 保留现有同值角色。

**The Action Color Rule.** 主要动作、当前步骤和来源链接共用森林绿；分类、警告和错误保留各自语义颜色。

## Typography

各字号从现有规则映射，没有固定的等比字号级数。中文标题和正文共用系统字体栈；等宽字体用于来源编号、版本与英文辅助信息，不替代中文正文。

- Display 对应知识页面标题；Headline 对应工作台标题，窄屏（最大 480px）缩为（1.625rem）。
- Title 对应工作台分区标题；Body 是页面基础正文；Label 对应表单标签。
- 阅读段落使用（15px／1.9 行高），最大宽度（72ch）；导语最大宽度（68ch），行高（1.85）。
- 按钮正文为（14px）；工作台辅助注释、上下文与标题版本小字为（.8125rem），分区和复核详情说明段落为（.9375rem，即 15px）。英语定义以次级文字保留并允许长词换行。

**The One Font Stack Rule.** 中文内容和操作控件使用现有系统字体栈；来源与版本信息才使用等宽字体。

## Layout

顶栏高度（64px），桌面侧栏宽度（240px），主体最大宽度（1280px）。主体移动端左右内边距（20px）；最小 720px 时为（24px），最小 1024px 时为（40px）。桌面侧栏在顶栏下固定可见；更窄屏幕使用可关闭的抽屉。

知识网格在最小 720px 时进入双列，在最小 1024px 时可进入三列；层级表在最小 720px 时形成矩阵，窄屏按缩进大纲阅读。最小 1200px 的阅读页将目录放到右侧（210px）。

工作台上传区为双列，复核区为列表与详情两列；最大 1100px 时缩小间距，最大 760px 时改为单列，最大 480px 时期间、议题选项和复核字段改为单列。结果表最小宽度（900px），由容器横向滚动。

主要按钮、侧栏导航和工作台表单最小高度（44px），三步导航最小高度（48px）。紧凑例外保留实际代码：顶栏搜索高度（42px）、文字辅助操作最小高度（36px）；筛选按钮在最大 719px 时升为（44px）。

**The Keep Rows Readable Rule.** 长表格保留横向滚动，长词与来源文本允许换行；不要靠缩小正文挤入窄屏。

2026-10-08 布局补充（Asia/Shanghai，普通扩展）：Overview 中“未访问真实浏览器、响应布局尚未验收”描述的是 2026-10-06 的历史状态。当前初评结果在视口不超过（1200px）时按指标纵向排列，判断、已有披露／Gap、建议和操作以标签先于内容呈现；更宽屏幕保留五列。这一补充更新上文对初评结果表窄屏统一横向滚动的历史描述，知识阅读长表仍沿用既有横向滚动。

现有 Edge 证据覆盖（320／390／768／1440／1504px）：1440 与 390px 为上传、初评、复核三页完整记录，其余三种宽度为初评；390px 五个知识模块首屏及查询、320px 抽屉另有记录。已测宽度支持当前响应行为，不表示实体手机、Safari、全断点或全部知识全文／来源链接均已验收。原设计系统与全部 frontmatter 保留；本轮不重新提取令牌，不改写 sidecar。

## Elevation & Depth

常态界面不靠外投影区分卡片；白色、浅灰、分隔线与间距构成层次。移动抽屉打开时使用现有柔和阴影；桌面侧栏无阴影。层级表的内嵌阴影用于模拟单元格分隔线，支柱按钮选中时使用白色内描边，均不表示悬浮卡片。

按钮与筛选状态为短颜色过渡（0.15s ease），抽屉位移为（0.24s ease），菜单图形变化为（0.2s ease）。减弱动态偏好将过渡与动画时长压到（0.01ms）；不增加过场动画。

**The Flat Surface Rule.** 阅读列表和工作台分区以底部分隔线组织；抽屉阴影与表格内描边仅用于既有功能状态。

## Shapes

按钮、输入、导航和来源文本使用小圆角；表格容器、上传区与导出面板使用容器圆角，值见 rounded。筛选按钮与标签使用胶囊形，类型标记使用小方角。阅读行和工作台分区保持平直边界，不包装为浮起的装饰卡片。

线条通常为（1px）；上传区采用虚线。全局键盘焦点使用森林绿描边（2px）与外间距（2px），上传区的内部控件获得焦点时，外间距为（3px）。

## Components

### Buttons

主要按钮为森林绿底、白字，悬停变深绿并保持白字。次要按钮为白底、细边框，悬停边框和文字变绿。主按钮兼容知识页和工作台现有写法；不以当前页面改换操作色。禁用按钮保留现有透明度，知识页为（.5）、工作台为（.55）；辅助文字操作保持底线。

### Inputs

工作台字段为白底、较明显的边界与小圆角；占满所属列，最小高度如 Layout。占位文字采用 muted，光标采用森林绿。键盘焦点有统一描边；字段没有额外的悬停变色。查询输入保留可收缩最小宽度（0），不能回退为 flex 默认最小尺寸。

### Navigation

侧栏导航以浅绿背景和森林绿字标记当前页；选中项悬停仍维持选中层次。图标为现有线性 SVG。移动抽屉打开时限制背景操作，关闭后恢复；样式片段展示状态，不替代应用中的导航逻辑。

### Chips

筛选按钮为白底、细边框与胶囊形；悬停仅强调边界，选中后为森林绿底与白字。分类标签沿用支柱语义色；只读标签与可操作筛选按钮保持不同用途。

### Reading Rows

查询结果以白底和底部分隔线形成连续列表；悬停时标题变绿并加底线，不移动整行。阅读段落、英文定义和来源页码保留各自层次；提示或命中标记不能覆盖原文字义。

### Step Navigation

三步导航固定为等宽三列，以文字和底线标记当前页，悬停采用浅灰背景。选中状态跟随现有 aria-selected；只展开当前页。窄屏减少间距，保持当前流程顺序。

### Report Upload

上传区使用浅灰底、虚线边界和容器圆角；悬停改为浅绿背景与森林绿边界。文件控件保留可达性，区内焦点在容器外显示描边，不隐藏提示或文件格式说明。

### Evidence and Completion（2026-10-08 补充）

报告出处使用原生可折叠项，第一条默认展开，其余先显示出处行。完整引文不裁切；长摘录区域最大高度为（min(42vh, 320px)），超出部分在区域内滚动，并保留键盘焦点、区域角色与出处名称。已有 Edge 交互记录包含 Space 开闭、键盘内部滚动，以及窄屏导航的 Escape 关闭和回焦点。

当非空批次的完成、失败和待全文核验数量合计达到总量时，恢复草稿优先显示“本轮处理结束”，继续按钮仍禁用；仍有未处理任务的暂停／停止批次沿用原状态。此处只记录现有展示行为，不改变任务队列、模型、评分或复核数据。本轮公开报告的人工确认仍为 0；独立 ship 仅覆盖终态文案 R1 修复及同组截图未退化。

## Do's and Don'ts

### Do:

- **Do** 用森林绿标记主要动作、当前步骤与来源链接，保持主按钮悬停白字。
- **Do** 用分隔线、字号和间距组织阅读与工作台密度，保持现有中文和英文层次。
- **Do** 保留主要操作面积、键盘焦点、长表横向滚动与长词换行。
- **Do** 从实际样式更新令牌与扩展文件，并分别记录离线检查和真实浏览器验收。

### Don't:

- **Don't** 为常态阅读列表和工作台分区添加装饰阴影、渐变或过场动画。
- **Don't** 用浅色分隔线作为版本文字颜色，或移除查询输入的可收缩最小宽度。
- **Don't** 添加未实施的令牌、颜色梯度或组件，或将开发方向说明写入设计规范。
- **Don't** 把源码、离线 DOM 或颜色抽样通过表述为像素一致或真实浏览器视觉通过。
