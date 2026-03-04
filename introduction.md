# 鱼骨图组件实现详解

## 概述

鱼骨图（又叫因果图、石川图）是一种常见的**问题分析工具**。它的形状像一条鱼的骨架：

- **鱼头**：写上要分析的问题（比如"系统响应慢"）
- **主骨线**：一条水平线，连接鱼头和鱼尾
- **大骨**：从主骨线斜伸出去的线，代表问题的大分类（比如"人员""技术""流程"）
- **中骨**：从大骨上水平伸出的线，代表具体原因
- **小骨**：从中骨上伸出的线，代表更细致的原因

本组件基于 **Vue 3** + **@antv/x6**（图形库）+ **Arco Design**（UI 库）实现了一个可交互的鱼骨图编辑器，支持新增/删除/编辑骨骼、拖拽平移、滚轮缩放等功能。

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          index.vue                               │
│   组件入口：组装 composables，管理数据，调用渲染                     │
│   - 数据管理（fishData、setData、getData）                        │
│   - 骨骼增删（addBigBone、addMidBone、addSmallBone）              │
│   - 核心渲染（renderGraph → _renderGraph）                        │
│   - 鱼头编辑、居中逻辑                                            │
└──────┬──────────┬──────────┬──────────┬─────────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────────┐
│ usePanZoom │ │useOverlay│ │useViewport   │ │    layout.js     │
│    .js     │ │ Edit.js  │ │ Resize.js    │ │                  │
│            │ │          │ │              │ │  纯数学布局计算   │
│ 拖拽+缩放  │ │ 骨骼编辑  │ │ 容器尺寸监听  │ │  坐标/尺寸/分组   │
└────────────┘ └──────────┘ └──────────────┘ └──────────────────┘
                                                     │
                                               ┌─────┴─────┐
                                               │ drawer.js  │
                                               │            │
                                               │ 封装 X6 的  │
                                               │ 绘图 API    │
                                               └────────────┘
```

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.vue` | ~880 | 组件入口，组装 composables，管理数据，核心渲染，模板和样式 |
| `layout.js` | ~300 | 纯数学布局：根据数据计算每个元素的坐标和画布尺寸 |
| `drawer.js` | ~150 | 封装 X6 绘图 API：画线、画标签、画按钮 |
| `usePanZoom.js` | ~88 | Composable：画布拖拽平移 + 滚轮缩放 + 缩放按钮 |
| `useOverlayEdit.js` | ~88 | Composable：骨骼标签的 hover 编辑、输入、删除 |
| `useViewportResize.js` | ~33 | Composable：监听视口尺寸变化，自动重绘居中 |

---

## 数据结构

在了解代码之前，先理解鱼骨图的数据是什么样的。

### 外部数据（传入/导出的格式）

这是你调用 `init(data)` 时传入的数据，也是 `getData()` 导出的数据。**只有业务字段，没有内部字段**：

```javascript
{
  headLabel: "系统响应慢",        // 鱼头标题（要分析的问题）
  bigBones: [                     // 大骨数组（问题的大分类）
    {
      label: "人员",              // 大骨名称
      midBones: [                 // 中骨数组（具体原因）
        {
          label: "培训不足",      // 中骨名称
          smallBones: [           // 小骨数组（更细的原因）
            { label: "新员工多" },
            { label: "文档缺失" }
          ]
        },
        {
          label: "人手不够",
          smallBones: [
            { label: "预算限制" }
          ]
        }
      ]
    },
    {
      label: "技术",
      midBones: [ ... ]
    }
  ]
}
```

### 内部数据（运行时自动生成）

`setData()` 处理后，内部会给每个骨骼额外加上一些字段，**这些字段不会被 `getData()` 导出**：

```javascript
// 大骨内部结构
{
  id: "n_1",              // 唯一 ID（自动生成）
  colorIndex: 0,          // 颜色索引（永久绑定，删除其他大骨不会改变）
  label: "人员",
  position: "top",        // "top" = 在主骨线上方，"bottom" = 在下方
  midBoneSeq: 2,          // 中骨序号计数器（只增不减，用于新增中骨的默认名称）
  midBones: [ ... ]
}

// 中骨内部结构
{
  id: "n_2",
  label: "培训不足",
  smallBoneSeq: 2,        // 小骨序号计数器
  smallBones: [ ... ]
}

// 小骨内部结构
{
  id: "n_3",
  label: "新员工多"
}
```

**为什么要分开？**
- `id`、`colorIndex`、`position`、`midBoneSeq` 等都是组件渲染和交互用的临时数据
- 每次重新 `init()` 会重新生成，不需要也不应该持久化
- `getData()` 用白名单方式只导出 `label` 字段，确保数据干净

---

## layout.js — 布局计算模块

这个文件**只做数学计算**，不涉及任何 DOM 操作或 Vue 响应式。它的输入是鱼骨图数据，输出是所有元素的坐标和画布尺寸。

### 导出常量

所有可调节的布局参数都集中在这里，方便统一管理：

```javascript
LINE_CHARS = 10               // 每行最多显示字符数，超过则换行
BIG_GAP = 100                 // 大骨之间的最小宽度
DIAG = 150                    // 大骨斜线默认长度（像素）
MID_LEN = 90                  // 中骨水平线默认长度
PAIR_GAP = 60                 // 上下两根大骨的间距
PAD_L = 70                    // 画布左侧留白
TAIL = 50                     // 鱼尾到主骨线的距离
CY = 350                      // 主骨线的 Y 坐标（画布垂直中心）
EMPTY_OFFSET_X = -250         // 空图时的整体偏移量
BTN_SIZE = 20                 // 加号按钮可见尺寸
BTN_HIT_SIZE = 34             // 加号按钮点击热区尺寸（比可见尺寸大，更容易点到）
CENTER_OFFSET_Y = 20          // 居中后向下视觉补偿（正值=下移，抵消底部操作栏的视觉偏移）
FISH_SCALE_BASE = 1.6         // 鱼头文字缩放基准
CENTER_PADDING = 60           // 居中计算时视口预留边距
INIT_RENDER_MAX_RETRIES = 50  // init 时等待容器就绪的最大重试次数（防止死循环）
```

### calculateLayout(fishData) — 布局入口函数

**输入**：鱼骨图数据对象 `fishData`
**输出**：包含所有布局信息的对象，供 `renderGraph()` 使用

#### 计算流程（分 6 步）

**第 1 步：计算每个方框的尺寸**

```javascript
// 小骨方框高度（文字超过 10 字就要换行，高度增加）
function smBoxH(sm) {
  return sm.label.length > LINE_CHARS ? SM_BOX_H * 1.8 : SM_BOX_H
}
// 同理还有 midBoxH(m)、bigBoxH(b)
```

图示：
```
文字 ≤ 10 字              文字 > 10 字
┌─────────────┐          ┌─────────────┐
│   小骨标签   │          │  小骨标签第  │
│             │  24px     │  一行第二行  │  43px
└─────────────┘          └─────────────┘
```

方框宽度根据文字长度动态计算：
```javascript
function calcBoxW(text, fs = 11) {
  const len = text.length
  const lineW = Math.min(len, LINE_CHARS) * (fs * 1.0) + 20  // 每字符约 1 倍字号宽 + 左右内边距
  return Math.max(lineW, 80)  // 最小宽度 80
}
```

**第 2 步：计算中骨在斜线上占用的间距**

```javascript
function midBoneSpan(m) {
  const midH = midBoxH(m)
  const smH = totalSmallBonesH(m)          // 所有小骨的总高度
  const needed = Math.max(midH + 20, smH + midH)
  return Math.ceil(needed * Math.SQRT2)    // 乘 √2：斜线距离 = 垂直距离 × √2
}
```

为什么乘 √2？因为大骨是 45° 斜线，沿着斜线的距离 = 垂直/水平距离 × √2。

**第 3 步：计算大骨斜线总长度**

```javascript
function calcDiag(b) {
  if (b.midBones.length === 0) return DIAG   // 没有中骨时用默认长度
  let total = calcHeadMargin(b)               // 斜线顶端留白
  for (const m of b.midBones) {
    total += midBoneSpan(m)                   // 累加每个中骨的跨度
  }
  total += 50                                 // 尾部留白
  return Math.max(DIAG, total)                // 至少使用默认长度
}
```

**第 4 步：大骨分组**

每 2 根大骨为一组（上方一根、下方一根）：
```
大骨数组: [大骨1, 大骨2, 大骨3, 大骨4, 大骨5]

分组结果:
  组1: { top: 大骨1, bot: 大骨2 }   ← 大骨1在上，大骨2在下
  组2: { top: 大骨3, bot: 大骨4 }
  组3: { top: 大骨5, bot: null }    ← 奇数时下方为空
```

**第 5 步：计算每组的 X 坐标**

从右向左排列。每组占用的宽度取决于内部骨骼向左延伸的最大距离。

**第 6 步：计算画布尺寸和偏移**

遍历所有骨骼，找到最左/最右/最上/最下的坐标，确定画布大小。如果有元素超出边界，整体偏移使其回到画布内。

---

## drawer.js — 绘图辅助模块

这个文件封装了 @antv/x6 的绘图 API，让 `renderGraph()` 里的绘图代码更简洁。

### createDrawer(options) — 创建绘图器

传入 X6 图形实例等参数，返回 4 个绘图函数：

```javascript
const { addEdge, addCurvedEdge, addLabelNode, addBtn } = createDrawer({
  graph,          // X6 图形实例
  mode,           // 当前模式 ('edit' 或 'view')
  editOverlays,   // 编辑覆盖层数组（Vue ref）
  callbackMap,    // 按钮点击回调映射
  LINE_CHARS,     // 每行字符数
})
```

#### addEdge(起点, 终点, 颜色, 线宽) — 画直线

```javascript
addEdge([100, 200], [300, 200], '#00A68D', 4)
//       起点x,y     终点x,y    颜色       线宽
```

图示：
```
(100,200) ━━━━━━━━━━━━━━━ (300,200)
           颜色: #00A68D
           线宽: 4px
```

#### addCurvedEdge(起点, 终点, 颜色, 线宽) — 画贝塞尔弧线

用于多个小骨从同一点分叉出去的场景。自动计算贝塞尔曲线的控制点。

```
分叉点 ●─────╮
             ╰──── 小骨1
分叉点 ●─────╮
             ╰──── 小骨2
```

#### addLabelNode(...) — 添加标签节点

这是最复杂的绘图函数。它有两种渲染模式：

1. **有 `boneRef` 参数**：推入 `editOverlays` 数组，由 Vue 模板渲染为 HTML `<div>` + `<input>`（支持编辑）
2. **无 `boneRef` 参数**：直接用 X6 的 `graph.addNode()` 渲染为 SVG 节点（不可编辑）

所有骨骼标签都走第 1 种模式，因此 hover 时可以切换为 `<input>` 进行编辑。

`growDir` 参数控制文字换行时方框的增长方向：
```
growDir = -1 (向上增长)     growDir = 0 (居中)      growDir = 1 (向下增长)
┌─────────────┐           ┌─────────────┐         ┌─────────────┐
│   标签文字   │           │             │         │             │
│   标签文字   │           │   标签文字   │         │   标签文字   │
│      ●      │           │   标签文字   │         │   标签文字   │
└─────────────┘           └─────────────┘         └─────────────┘
  (大骨在上方时)             (中骨/小骨)              (大骨在下方时)
```

#### addBtn(id, x, y, color, tip, fn) — 添加加号按钮

只在编辑模式（`mode === 'edit'`）下显示。按钮采用**双层结构**：

```
┌────────────────┐  ← 外层：34×34 透明矩形（点击热区，肉眼不可见）
│  ┌──────────┐  │
│  │    +     │  │  ← 内层：20×20 彩色方块 + "+"文字（肉眼可见）
│  └──────────┘  │
└────────────────┘
```

这样**热区比按钮大**，用户更容易点到，但视觉上按钮不会显得太大。

### BONE_COLORS — 大骨颜色数组

```javascript
const BONE_COLORS = [
  '#B37DD8',  // 紫色
  '#6C9E42',  // 绿色
  '#D77D1E',  // 橙色
  '#8793B9',  // 灰蓝
  '#CE75B8',  // 粉色
  '#668FF5',  // 蓝色
  '#00A0C8',  // 青色
  '#BB8C00',  // 金色
  '#00A68D',  // 深青
  '#E96F56',  // 红色
]
```

颜色通过 `getBoneColor(bigIndex)` 获取，用 `bigIndex % 10` 循环取色。

**重要**：每个大骨在创建时会分配一个永久的 `colorIndex`，即使删除了前面的大骨，剩余大骨的颜色也不会变化。

---

## Composables（可组合函数）

### usePanZoom.js — 拖拽平移 + 滚轮缩放

**职责**：处理画布的拖拽移动和缩放交互

**对外暴露**：

| 名称 | 类型 | 说明 |
|------|------|------|
| `panX`, `panY` | ref | 画布平移偏移量 |
| `scale` | ref | 当前缩放比例 |
| `displayScale` | computed | 显示的缩放百分比（相对于初始缩放） |
| `onPointerDown` | function | 绑定到视口的 pointerdown 事件 |
| `onWheel` | function | 绑定到视口的 wheel 事件 |
| `zoomIn` / `zoomOut` | function | 放大/缩小按钮的回调 |
| `getDidDrag` | function | 返回是否发生了拖拽（用于区分拖拽和点击） |

**拖拽原理**：
```
1. pointerdown  → 记录起始鼠标位置和画布位置
2. pointermove  → 计算鼠标偏移量，更新画布位置
3. pointerup    → 结束拖拽
```

**缩放原理**：以鼠标位置为中心缩放。公式：
```
新平移 = 鼠标位置 - (鼠标位置 - 旧平移) × (新缩放 / 旧缩放)
```

### useOverlayEdit.js — 骨骼编辑交互

**职责**：处理骨骼标签的 hover、编辑、删除

**核心逻辑**：

```
1. 鼠标进入骨骼标签 (onOverlayMouseEnter)
   → 记录原始文字，设置 hoveringOverlayId
   → Vue 模板根据 hoveringOverlayId 把 <div> 切换为 <input>
   → input 自动 focus

2. 用户编辑文字 (onOverlayInput)
   → 实时更新 boneRef.label（最多 20 字）

3. 鼠标离开骨骼标签 (onOverlayMouseLeave)
   → 比较当前文字和原始文字
   → 如果文字没有改变：只清除 hoveringOverlayId，不重绘（避免无意义的性能消耗）
   → 如果文字改变了：清除 hoveringOverlayId + 调用 renderGraph() 重绘（因为文字变化可能影响布局）

4. input 失焦 (onOverlayBlur)
   → 不做任何操作，交给 mouseLeave 统一处理
   → 为什么？因为 blur 可能在 mouseLeave 之前触发，如果 blur 里清了 hoveringOverlayId，
     会导致 input 立刻切回 div（闪烁），然后 mouseLeave 发现 id 已经不匹配就跳过了
```

**删除骨骼** (`deleteBone`)：

删除前会弹出 Arco Design 的 `<a-popconfirm>` 确认气泡，用户点"确定"后才真正删除。

删除大骨后会重新计算所有大骨的 `position`（上/下交替排列）。

### useViewportResize.js — 视口尺寸监听

**职责**：当 Modal 放大/缩小/全屏时，自动重新绘制并居中

**原理**：
```
1. onMounted 时创建 ResizeObserver 监听 viewportRef
2. 尺寸变化时 → 200ms 防抖 → 设置 needsCenter = true → 调用 renderGraph()
3. onBeforeUnmount 时断开 ResizeObserver + 清除定时器
```

---

## index.vue — 主组件

### 组装 composables

```javascript
// 拖拽+缩放
const { panX, panY, scale, displayScale, onPointerDown, onWheel, zoomIn, zoomOut, getDidDrag }
  = usePanZoom({ viewportRef, isFirstRender, baseScale })

// 骨骼编辑
const { hoveringOverlayId, onOverlayBlur, onOverlayInput, onOverlayMouseEnter, onOverlayMouseLeave, ... }
  = useOverlayEdit({ mode, editOverlays, renderGraph })

// 视口尺寸监听
useViewportResize({ viewportRef, isFirstRender, renderGraph, setNeedsCenter })
```

### init(dataOrPromise) — 初始化入口

外部调用这个方法来渲染鱼骨图。支持 3 种调用方式：

```javascript
// 方式 1：传入数据对象
fishboneRef.value.init({ headLabel: '问题', bigBones: [...] })

// 方式 2：传入 Promise（组件内部自动 loading）
fishboneRef.value.init(fetchDataFromApi())

// 方式 3：不传参（打开空白图）
fishboneRef.value.init()
```

内部流程：
```
init() → setData() → 等待 DOM 就绪（最多重试 50 次）→ renderGraph()
```

### 序号计数器机制

新增骨骼时，默认名称用**固定递增计数器**，不会因为删除而回填编号：

```
操作序列:
  新增大骨 → "大骨 1"    (bigBoneSeq: 1)
  新增大骨 → "大骨 2"    (bigBoneSeq: 2)
  新增大骨 → "大骨 3"    (bigBoneSeq: 3)
  删除大骨2
  新增大骨 → "大骨 4"    (bigBoneSeq: 4)  ← 不会回到"大骨 2"
```

中骨和小骨的计数器挂在父节点上（`big.midBoneSeq`、`mid.smallBoneSeq`），同样只增不减。

### renderGraph() — 节流 + 核心渲染

```javascript
// 节流包装：用 requestAnimationFrame 合并同一帧内的多次调用
let renderRafId = null

function renderGraph() {
  if (renderRafId !== null) return          // 已经有一个排队了，跳过
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null
    _renderGraph()                          // 真正的渲染
  })
}
```

**为什么要节流？** 连续快速操作（比如一口气删 5 个小骨）会触发多次 `renderGraph()`，但其实只需要最后渲染一次。`requestAnimationFrame` 把同一帧内的多次调用合并为一次。

#### _renderGraph() 内部流程

```
步骤 1：清理旧画布
  graph.dispose()  ← 用 try-catch 保护，已 dispose 不报错
  containerRef.innerHTML = ''
  editOverlays = []

步骤 2：计算布局
  calculateLayout(fishData) → 得到 slots、canvasW、canvasH 等

步骤 3：创建新的 X6 画布
  new Graph({ container, width, height, ... })

步骤 4：创建绘图器
  createDrawer({ graph, mode, editOverlays, callbackMap, LINE_CHARS })

步骤 5：绘制主骨线
  addEdge(鱼尾端, 鱼头端, '#00A68D', 4)
  addBtn('新增大骨')

步骤 6：遍历每根大骨
  for (const slot of slots) {
    // 取颜色（用 colorIndex 而非数组下标，删除后颜色不变）
    const boneColor = getBoneColor(b.colorIndex)

    // 画大骨斜线 + 大骨标签
    // 画"新增中骨"按钮

    // 遍历中骨
    for (const m of b.midBones) {
      // 画中骨水平线 + 中骨标签
      // 画"新增小骨"按钮

      // 画小骨
      if (1个小骨) → 直线连接
      if (多个小骨) → 弧线分叉连接
    }
  }

步骤 7：自动居中（needsCenter = true 时）
  计算缩放比使图形适配视口
  计算平移使图形居中
  加上 CENTER_OFFSET_Y 向下补偿（抵消底部操作栏的视觉偏移）
```

### getData() — 纯净导出

```javascript
function getData() {
  return {
    headLabel: headLabel.value,
    bigBones: fishData.bigBones.map(b => ({
      label: b.label,                              // ✅ 只导出 label
      midBones: b.midBones.map(m => ({
        label: m.label,
        smallBones: m.smallBones.map(s => ({ label: s.label })),
      })),
    })),
    // ❌ 不导出 id、colorIndex、position、midBoneSeq、smallBoneSeq
  }
}
```

### 模板结构

```
┌─ .fishbone-page ─────────────────────────────────────────┐
│                                                           │
│  ┌─ .fishbone-viewport ────────────────────────────────┐  │
│  │  (可拖拽/缩放的视口区域)                              │  │
│  │                                                      │  │
│  │  ┌─ .fishbone-world ─────────────────────────────┐   │  │
│  │  │  (通过 CSS transform 实现平移和缩放)            │   │  │
│  │  │                                                │   │  │
│  │  │  ┌─ .fishbone-canvas ─┐  ← X6 画布(线条)      │   │  │
│  │  │  └────────────────────┘                        │   │  │
│  │  │  ┌─ .fish-part ──┐  ← 鱼尾 SVG                │   │  │
│  │  │  └───────────────┘                             │   │  │
│  │  │  ┌─ .fish-part ──┐  ← 鱼头 SVG + 鱼头标签     │   │  │
│  │  │  └───────────────┘                             │   │  │
│  │  │  ┌─ .inline-edit-wrap ─┐  ← 骨骼编辑覆盖层 ×N │   │  │
│  │  │  │  <input> 或 <div>   │                       │   │  │
│  │  │  │  ×删除按钮           │                       │   │  │
│  │  │  └─────────────────────┘                       │   │  │
│  │  └────────────────────────────────────────────────┘   │  │
│  │                                                      │  │
│  │  ┌─ .scale-text ─┐  ← 缩放百分比 (绝对定位)         │  │
│  │  └───────────────┘                                   │  │
│  │  ┌─ .zoom-control ──┐  ← 放大/还原/缩小 (绝对定位)  │  │
│  │  └──────────────────┘                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─ .fishbone-footer ──────────────────────────────────┐  │
│  │  [编辑/详情 切换]                    [取消] [确定]    │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

缩放控件和百分比文字是**绝对定位**在 viewport 内部的，不占布局空间。

---

## 渲染流程图

```
用户调用 init(data)
       │
       ▼
  ┌──────────────┐
  │  setData()   │  处理数据，生成 id/colorIndex/position 等内部字段
  └──────┬───────┘
         │
         ▼
  等待 DOM 就绪（最多 50 次 × 60ms）
         │
         ▼
  ┌──────────────┐
  │ renderGraph()│  rAF 节流包装
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │_renderGraph()│  真正的渲染
  └──────┬───────┘
         │
         ├── 清理旧画布（graph.dispose + innerHTML = ''）
         │
         ├── calculateLayout(fishData)
         │     └── 返回 slots、canvasW、canvasH、坐标函数等
         │
         ├── new Graph({ ... })  创建 X6 画布
         │
         ├── createDrawer({ ... })  获取绘图函数
         │
         ├── 绘制主骨线 + "新增大骨"按钮
         │
         ├── 遍历大骨 slots
         │     │
         │     ├── 绘制大骨斜线 + 标签
         │     ├── "新增中骨"按钮
         │     │
         │     └── 遍历中骨
         │           ├── 绘制中骨水平线 + 标签
         │           ├── "新增小骨"按钮
         │           └── 绘制小骨（单个=直线，多个=弧线分叉）
         │
         ├── 设置鱼头/鱼尾位置
         │
         └── 自动居中（needsCenter 时）
               ├── 计算 fitScale
               ├── 计算 panX / panY
               └── 记录 baseScale
```

---

## 使用示例

```vue
<template>
  <div>
    <a-button @click="openFishbone">打开鱼骨图</a-button>

    <a-modal v-model:visible="showFishbone" :footer="false"
      :width="'90vw'" :body-style="{ padding: 0, height: '80vh', overflow: 'hidden' }">
      <FishboneDiagram
        ref="fishboneRef"
        v-model="mode"
        @confirm="onConfirm"
        @cancel="onCancel"
      />
    </a-modal>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue'
import FishboneDiagram from './components/MyFishboneDiagram/index.vue'

const showFishbone = ref(false)
const fishboneRef = ref(null)
const mode = ref('edit')

function openFishbone() {
  showFishbone.value = true
  // 支持传 Promise，组件内部会自动显示 loading
  nextTick(() => fishboneRef.value?.init(fetchData()))
}

function fetchData() {
  return fetch('/api/fishbone').then(r => r.json())
}

function onConfirm() {
  const data = fishboneRef.value?.getData()
  console.log('导出数据:', data)
  // data 只包含 headLabel + 各层 label，可直接提交给后端
  showFishbone.value = false
}

function onCancel() {
  showFishbone.value = false
}
</script>
```

### 组件 API

| 方法 | 说明 |
|------|------|
| `init(data \| Promise \| Function)` | 初始化并渲染。支持直接传数据、Promise、或 async 函数 |
| `setData(data)` | 仅设置数据，不触发渲染 |
| `getData()` | 获取纯净数据（只有 label 字段），用于持久化 |

| Props | 说明 |
|-------|------|
| `v-model` / `modelValue` | 模式，`'edit'` 或 `'view'` |

| Events | 说明 |
|--------|------|
| `confirm` | 点击"确定"按钮 |
| `cancel` | 点击"取消"按钮 |

---

## 关键设计决策

### 1. 为什么用 HTML overlay 而不是全部用 X6 节点？

X6 节点是 SVG 元素，编辑文字需要额外的交互处理。而 HTML 的 `<input>` 天然支持文字输入、光标、选中等操作，体验更好。所以骨骼标签用 Vue 模板渲染为 HTML `<div>`/`<input>` 覆盖在 X6 画布上方。

### 2. 为什么每次都全量重绘？

当前每次数据变化都会 `graph.dispose()` 后重建。这样做的好处是逻辑简单、不容易出 bug。通过 `requestAnimationFrame` 节流，即使连续触发多次也只重绘一次，性能足够。

### 3. 为什么 colorIndex 不用数组下标？

如果用数组下标取颜色，删除"大骨 1"后，"大骨 2"变成了下标 0，颜色就变了。用 `colorIndex`（创建时递增分配）可以保证**每个大骨的颜色永远不变**。

### 4. 为什么 blur 不做任何操作？

在鼠标离开骨骼标签时，浏览器会先触发 `blur`（input 失焦），再触发 `mouseleave`。如果 `blur` 里清了 `hoveringOverlayId`，会导致 input 瞬间切回 div（闪烁），然后 `mouseleave` 的判断失效。所以 `blur` 里什么都不做，统一由 `mouseleave` 处理。

---

## 涉及的算法与技术

本组件没有使用现成的图布局库，而是自己实现了一套专用于鱼骨图的布局和交互算法。

### 1. 自底向上的树形布局算法

整体布局的计算顺序是**从叶子到根**，逐层向上累加尺寸：

```
小骨高度 → 中骨跨度 → 大骨斜线长度 → 大骨组宽度 → 画布总尺寸
```

每一层的尺寸取决于子节点的尺寸之和，类似树的**后序遍历**——先算完所有子节点，才能确定父节点的大小。

### 2. 45° 斜线投影 + √2 系数

大骨是 45° 斜线，中骨沿斜线均匀分布。垂直距离和斜线距离之间的转换用到了 45° 投影公式：

```
斜线距离 = 垂直距离 × √2
```

```javascript
// 中骨在斜线上占用的间距（垂直距离 → 斜线距离）
return Math.ceil(needed * Math.SQRT2)

// 斜线终点坐标（斜线长度 → 水平/垂直投影）
const dd = dynamicDiag / Math.SQRT2
const ex = bx - dd        // X 方向投影
const ey = cy + dir * dd  // Y 方向投影（dir=±1 控制上/下）
```

这是**向量投影**的特例：45° 时 cos45° = sin45° = 1/√2。

### 3. 参数化线性插值（Lerp）

中骨在大骨斜线上的锚点位置，用**参数 t ∈ [0,1]** 做线性插值：

```javascript
const t = centerOffset / dynamicDiag  // 归一化参数（0=起点，1=终点）
const ax = sx + (ex - sx) * t         // X = 起点 + 方向向量 × t
const ay = sy + (ey - sy) * t         // Y = 起点 + 方向向量 × t
```

公式：`P(t) = P₀ + (P₁ - P₀) × t`，这是图形学中最基础的插值方法。

### 4. 三次贝塞尔曲线

多个小骨从同一点分叉时，用 SVG 的**三次贝塞尔曲线**（C 命令）连接：

```javascript
const cpX = Math.abs(t[0] - s[0]) * 0.65
const d = `M ${sx} ${sy} C ${sx - cpX} ${sy}, ${tx + cpX} ${ty}, ${tx} ${ty}`
```

两个控制点分别在起点和终点的水平延长线上，偏移量为水平距离的 65%，形成 S 型平滑弧线：

```
起点 ●──╮  ← 控制点1在起点左侧（水平）
        ╲
         ╲
          ╱
         ╱   ← 控制点2在终点右侧（水平）
终点 ●──╯
```

### 5. 缩放不动点（仿射变换）

滚轮缩放时，需要保持**鼠标指向的位置不动**（而不是画布中心不动）：

```javascript
panX = mx - (mx - panX) × (newScale / oldScale)
panY = my - (my - panY) × (newScale / oldScale)
```

推导过程：设鼠标在视口中的位置为 `m`，画布偏移为 `p`，缩放比为 `s`。鼠标对应的世界坐标 `w = (m - p) / s`。缩放后要保持 `w` 不变：

```
(m - p) / s = (m - p') / s'
→ p' = m - (m - p) × s' / s
```

### 6. 贪心分组

大骨分组用**贪心策略**：每 2 根配对（上+下），组宽度取上下的较大值：

```javascript
for (let i = 0; i < fishData.bigBones.length; i += 2) {
  groups.push({ top: fishData.bigBones[i], bot: fishData.bigBones[i + 1] || null })
}
```

组间距离通过逐步累加偏移量计算，类似一维装箱：从右到左排列，每组左边界取该组内所有骨骼向左延伸的最大距离。

### 7. AABB 包围盒

画布尺寸通过遍历所有元素，维护**轴对齐包围盒**（Axis-Aligned Bounding Box）来确定：

```javascript
let xMin = PAD_L - 20, xMax = mainEnd + 20
let yMin = CY, yMax = CY

for (const slot of slots) {
  // 遍历大骨、中骨、小骨，不断更新四个极值
  xMin = Math.min(xMin, ...)
  yMax = Math.max(yMax, ...)
}

// 如果有元素超出左边界，整体右移
let shiftX = xMin < tailSafeRight ? tailSafeRight - xMin : 0
```

### 8. requestAnimationFrame 节流

```javascript
let renderRafId = null
function renderGraph() {
  if (renderRafId !== null) return        // 已经有一个排队了，跳过
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null
    _renderGraph()                        // 下一帧才执行真正的渲染
  })
}
```

**rAF 节流**：同一帧（~16.7ms）内无论调用多少次 `renderGraph()`，只会在下一帧执行一次 `_renderGraph()`。比 `setTimeout` 节流更精确，因为它与浏览器的渲染帧同步。

### 9. 防抖（Debounce）

视口尺寸变化时用 200ms 防抖，避免拖动 Modal 边框时频繁重绘：

```javascript
function onViewportResize() {
  clearTimeout(resizeTimer)                // 每次触发都清除上一个定时器
  resizeTimer = setTimeout(() => {         // 重新设一个 200ms 后执行
    setNeedsCenter()
    renderGraph()
  }, 200)
}
```

只有在停止 resize 200ms 后才会真正重绘一次。

### 算法速查表

| 算法/技术 | 用在哪里 | 一句话概括 |
|-----------|----------|-----------|
| 自底向上树形布局 | layout.js 整体 | 叶子→根逐层算尺寸 |
| 45°投影 + √2 | 大骨斜线/中骨间距 | 垂直距离↔斜线距离转换 |
| 线性插值 Lerp | 中骨锚点定位 | 参数 t 在线段上取点 |
| 三次贝塞尔曲线 | 小骨分叉弧线 | SVG C 命令画平滑曲线 |
| 仿射变换缩放不动点 | 滚轮缩放 | 鼠标位置不动的缩放公式 |
| 贪心分组 | 大骨上下配对 | 每 2 根一组取最大宽度 |
| AABB 包围盒 | 画布尺寸计算 | 遍历取极值确定边界 |
| rAF 节流 | renderGraph | 同一帧只渲染一次 |
| 防抖 Debounce | 视口 resize | 停止变化后才重绘 |

---

## 总结

本鱼骨图组件通过**模块化分工**实现了完整的编辑功能：

| 模块 | 职责 | 特点 |
|------|------|------|
| `layout.js` | 纯数学计算 | 无副作用，输入数据输出坐标 |
| `drawer.js` | 封装 X6 API | 提供 4 个简洁的绘图函数 |
| `usePanZoom.js` | 拖拽+缩放 | 独立的交互逻辑 |
| `useOverlayEdit.js` | 编辑+删除 | hover 切换 input，mouseLeave 统一处理 |
| `useViewportResize.js` | 响应式重绘 | ResizeObserver + 防抖 |
| `index.vue` | 组装+渲染 | 数据管理 + renderGraph + 模板 |

核心设计思想：
- **布局计算与渲染分离**，布局是纯函数，易于调试和测试
- **HTML overlay 实现编辑**，体验接近原生输入框
- **colorIndex 永久绑定**，删除骨骼不影响其他骨骼的颜色
- **rAF 节流渲染**，连续操作不卡顿
- **composable 拆分**，每个文件职责单一，便于维护
- **纯净数据导出**，`getData()` 只包含业务字段
