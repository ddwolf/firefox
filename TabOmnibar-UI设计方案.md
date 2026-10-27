# TabOmnibar 边角设计方案

示意图 `TabOmnibar-UI设计方案.png` 是上一版草图。那张图里的 12px 圆角、「展开 / 收起」文字按钮和手写色值作废。以本文为准。

需求背景仍见 `TabOmnibar-UI设计需求文档.md`。本文只规定三件事：悬停卡片里的网址、标签和地址栏怎么接、地址栏和建议怎么合成一块。结构不变：

- 不做 `in`。地址栏不铺进标签，标签尺寸和位置不变。
- 不做 `aligned`。宽度仍是现有的 480px。
- 不做 `overlay`。浮层始终在标签栏下方。
- `float_follow`（默认）左缘跟着当前标签。`float_center` 在窗口水平正中。

同一套规则给 Firefox 和 Firefox Nightly 用。样式写在 `browser/themes/shared/`，不按版本分叉。Nightly 开了 Nova、正式版还是 Proton 时，沿用 urlbar 自己的 `@media -moz-pref("browser.nova.enabled")`，TabOmnibar 不再加一层皮肤。

---

## 1. 样式只复用，不新调

新界面长得像 Firefox 原来的面板和地址栏。主题一换（浅色、深色、Alpenglow、用主题扩展装的 LWT、高对比度），新组件跟着现有令牌变，不在 TabOmnibar 里写死颜色、圆角、阴影或字号。

做到这一点的办法：

- 不新增色板，不写 `#ffffff`、`#0250bb` 这类字面颜色。
- 不新增圆角数值。露出的角继续用原来的变量。
- 不新增阴影、字号、按钮底色、动效曲线。
- 间距用现成的 `--space-*`。
- 图标用树里已有的 SVG，`fill: currentColor`，并设 `-moz-context-properties: fill`，这样主题和 `forced-colors` 会给它上色。
- 高对比度下不要覆盖面板和地址栏已经接好的系统色。少写 `!important`。

| 部位 | 用现成的 |
|---|---|
| 悬停卡片的底、边、圆角、阴影 | `#tab-preview-panel` 已有的 panel 令牌：`--panel-background-color`、`--panel-border-color`、`--panel-border-radius`（来自 `--popup-border-radius`） |
| 悬停卡片宽度 | 现有 `--panel-width`（280px），不改成 320px |
| 标题、网址的字色和行数 | `.tab-preview-title`、`.tab-preview-uri`。网址次要色已经是 `--text-color-deemphasized` |
| 导航按钮 | 现有 `.tab-preview-nav` 的 toolbarbutton，不另画尺寸和圆角 |
| 标签圆角 | `--tab-border-radius` |
| 地址栏圆角 | `--urlbar-border-radius`（`calc(var(--urlbar-height) / 2)`，原生胶囊）。建议面板继续用 `--urlbarview-border-radius` |
| 地址栏底、边、聚焦、阴影 | `--toolbar-field-background-color`、`--toolbar-field-border-color`、`--toolbar-field-border-color-focus`、`--urlbar-background-box-shadow-open`、`--chrome-box-shadow` |
| 建议行的悬停和选中 | urlbar view 现有的行样式，不另做 4px 内缩和高亮色 |
| 输入行高度 | `--urlbar-height` |

两块白底相接时，相接的那个角是 0。这不是新圆角，只是把原来的圆角从接缝上拿掉。露在外面的角仍然是上表里的变量。主题把 `--urlbar-border-radius` 或 `--tab-border-radius` 改了，这里跟着改。

---

## 2. 悬停：单行网址，用箭头展开

悬停卡片保持现在的 tab preview。只改网址这一行：默认一行省略；排不下时，行尾放一个箭头，点它在同一张卡片里折成多行。

```
一行放得下：没有箭头

┌────────────────────────────────┐
│  ←   →                    锁   │
│  页面标题                      │
│  https://example.com/docs      │
└────────────────────────────────┘

超过一行：行尾是向下的箭头

┌────────────────────────────────┐
│  ←   →                    锁   │
│  Firefox Design — Photon notes │
│  https://firefox-source-docs… ▾│
└────────────────────────────────┘

点过之后：同一张卡片，箭头转为向上

┌────────────────────────────────┐
│  ←   →                    锁   │
│  Firefox Design — Photon notes │
│  https://firefox-source-docs. ▴│
│  mozilla.org/browser/urlbar/   │
│  overview.html                 │
└────────────────────────────────┘
```

### 2.1 箭头

视觉上不要「展开」「收起」文字，也不要新画的按钮底。

- 收起：`chrome://global/skin/icons/arrow-down-12.svg`
- 展开：`chrome://global/skin/icons/arrow-up-12.svg`

这就是侧栏、隐私设置、地址栏里已经在用的 12px 箭头。颜色用 `currentColor`，跟网址同一套 `--text-color-deemphasized`。不要另配蓝色。

热区沿用 toolbarbutton 的最小点击尺寸，外观保持图标本身。旁白名称用 Fluent（「展开完整网址」「收起完整网址」），`aria-expanded` 跟着状态走。屏幕上看不见这两个词。

不要用字符当图标的首选。现成 SVG 在 Windows、macOS、Linux 上大小一致，也会跟着主题变色。只有图标资源不可用时，才退到 `▾` / `▴`，并且同样用 `currentColor`。

### 2.2 网址

展示这个标签的完整 URL，不另做「只留域名」的文案。短不短由排版决定。

- 收起：一行，末尾省略。箭头完整可见，网址吃掉剩下的宽度。
- 展开：在现有字号和行高上折行，`overflow-wrap: anywhere`。最多 4 行，再长只在网址区域里滚动。卡片继续用 panel 的圆角。
- 用 `scrollWidth > clientWidth` 判断溢出。不超过一行就不放箭头。
- 点击箭头只切换折行，不打开地址栏，不关掉预览，不激活标签。
- Enter / Space 同样只切换。Esc 仍是关掉整张预览。
- 预览关闭或换成另一个标签，回到收起。不写入偏好。

悬停卡片和地址栏不同时出现。规则与现在的预览拦截一致。

---

## 3. 点击标签：接缝用原来的圆角

地址栏仍是原来的 urlbar，宽 480px，顶边贴着标签栏底边。不把它改成另一种面板。

### 3.1 `float_follow`

左缘与当前标签对齐。标签比地址栏窄，多出来的顶边露在标签右边。

```
  Inbox   ╭──────────────────╮  Notes
          │ Firefox Design  ×│
          ╰──────────────────┴────────────────────────────╮
          │ 锁   https://example.com/docs            ☆   │
          ╰───────────────────────────────────────────────╯
            标签底角为 0              露出的角仍是地址栏原来的圆角
```

- 当前标签的顶角继续 `--tab-border-radius`。底角改为 0。填充改用地址栏的 `--toolbar-field-background-color`，边用 `--toolbar-field-border-color`，底边不画。这样浅色、深色和 LWT 下，标签底和地址栏是同一种表面。
- 地址栏露出的角继续 `--urlbar-border-radius`。和标签相接的左上角是 0。
- 标签底边与地址栏顶边重叠 1px 到 2px，用标签的字段背景盖住落在标签宽度里的那一段顶边。标签右边的顶边保留。
- 阴影继续用地址栏打开时已有的 `--urlbar-background-box-shadow-open`。不新写一枚。标签不单独加阴影。
- 其他标签不动。
- 右边不够 480px 时，宽度收到距窗口 8px，但不小于现有的 `TAB_OMNIBAR_MIN` 那一档（280px）。再不够就贴右缘，并且不再焊接：地址栏四角都恢复 `--urlbar-border-radius`，标签恢复原样。标签被标签栏裁切、只露出一部分时同样不焊接。

### 3.2 `float_center`

面板在窗口正中，和当前标签没有共同的边，不做焊接。

- 四角都是 `--urlbar-border-radius`。
- 顶边贴着标签栏底边。
- 当前标签保持原样。
- 窗口过窄时，宽度收到距两侧各 8px，圆角变量不变。

### 3.3 输入行和聚焦

输入行里的图标、星标、内边距、全选，都是 urlbar 现成的行为，不重排。

聚焦沿用地址栏自己的焦点描边（`--toolbar-field-border-color-focus` / 现有的 focus outline）。不要再加一圈自定义光环。主题扩展改了焦点色，这里跟着变。

收起的触发不变：Esc、回车并导航、切换标签、失焦。收起后去掉焊接用的属性，标签回到原来的圆角和填充。

---

## 4. 建议列表：关掉外扩，不重画一行

建议弹出时多出来的一圈，是 urlbar 的联合背景在起作用：`--urlbar-background-overhang-open`（Nova 下 8px）加上 view 自己的 margin。左右边对不齐，像外面又垫了一层。

TabOmnibar 打开时只把这层外扩关掉，让输入行和建议继续用它们现在的样子：

- 在 `#urlbar[tabomnibar]` 上把 `--urlbar-background-overhang-open` 设为 0，联合背景的 inline / block outset 设为 0，view 的 margin 设为 0。
- 圆角仍由 `--urlbar-border-radius` 和 `--urlbarview-border-radius` 负责。输入行底角、建议列表顶角按 urlbar 打开时的现有规则相接（相接处为 0，最底下的角是地址栏圆角）。
- 行的悬停、键盘选中、图标列、分隔，全部保持 urlbar view 的规则。不新写行高亮色，不新写 4px 内缩。
- 列表太长时，仍在 urlbar 自己的滚动区域里滚。

`float_follow` 有建议时，标签焊接方式不变，面板变高。`float_center` 只变高，四角仍是地址栏圆角。

Proton 和 Nova 对 overhang 的默认值不同。置 0 写在 `#urlbar[tabomnibar]` 上，两条路径都生效，不必为 Nightly 再抄一份。

---

## 5. 状态

| 状态 | 标签 | 面板 |
|---|---|---|
| 默认 | 原样 | 无 |
| 悬停，网址一行放得下 | 原样 | 现有预览卡片，无箭头 |
| 悬停，网址溢出 | 原样 | 行尾向下箭头 |
| 悬停，已展开 | 原样 | 同一张卡片，网址最多 4 行，箭头向上 |
| `float_follow` 地址栏打开 | 顶角仍是标签圆角，底角为 0，填充用字段背景 | 左上角为 0，其余角是地址栏圆角，左缘对齐该标签 |
| `float_center` 地址栏打开 | 原样 | 四角都是地址栏圆角，窗口水平居中 |
| 有建议 | 与上一行相同 | 同一块 urlbar，外扩为 0，行样式不改 |
| 聚焦 | 焊接时填充仍是字段背景 | 地址栏原有的焦点边 |
| 收起 | 恢复原样 | 无 |

---

## 6. 动效

不新增曲线。地址栏出现和收起继续用现在的 `tabomnibar-float-in`。网址展开就是行高变化，不另写 keyframes。标签宽度在地址栏打开期间不做过渡。

偏好从 `float_follow` 改成 `float_center` 时，若地址栏正开着，直接收起。

---

## 7. 实现时落在哪

- 预览：`browser/components/tabbrowser/content/tab-hover-preview.mjs`、`browser/themes/shared/tabbrowser/tab-hover-preview.css`。箭头加在现有 `.tab-preview-uri` 那一行里。
- 地址栏位置和焊接属性：`browser/components/tabbrowser/content/tab-omnibar.mjs`。`float_follow` 才给当前标签加焊接属性，收起时去掉。`float_center` 不加。
- 外扩和「相接的角为 0」：`browser/themes/shared/urlbar.css` 里已有的 `#urlbar[tabomnibar]` 段。只改现有变量和相接角，不重写 urlbar 的背景、行和焦点。
- 字符串：箭头的旁白进 Fluent。不要把「展开」画到界面上。

主题自检：浅色、深色、一套带 `lwt-toolbar-field` 的主题、以及 `forced-colors` 下各看一次悬停卡片和打开的地址栏。四次里，表面色、边、焦点色、箭头颜色都应来自当前主题，而不是同一套浅色。

---

## 8. 验收

- 短网址没有箭头。长网址一行省略，行尾是向下箭头，点一下变成多行和向上箭头。这次点击不打开地址栏。
- 界面上看不到「展开」「收起」。读屏能听到对应名字。
- 悬停卡片的宽、圆角、底色和现在的 tab preview 一致，并随主题变化。
- `float_follow` 下，标签和地址栏之间没有缝，也没有双线。露出的圆角仍是 `--tab-border-radius` 和 `--urlbar-border-radius`。
- `float_center` 下，地址栏在窗口正中，四角是地址栏原来的圆角，标签外观不变。
- 建议打开后，左右边与输入行对齐，外面没有更宽的一圈。建议行的悬停样式与普通地址栏相同。
- 切换浅色、深色和一套 LWT 后，不改 TabOmnibar 的 CSS，卡片和地址栏的底、边、字、箭头一起变。
- 打开和收起时，其他标签的宽度和位置不被动画带着走。
