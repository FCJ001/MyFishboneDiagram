# 鱼骨图组件开发指南

## 目录

1. [整体介绍](#1-整体介绍)
2. [技术栈](#2-技术栈)
3. [文件结构](#3-文件结构)
4. [数据结构](#4-数据结构)
5. [核心流程](#5-核心流程)
6. [布局算法详解](#6-布局算法详解)
7. [编辑交互](#7-编辑交互)
8. [画布平移与缩放](#8-画布平移与缩放)
9. [可调参数速查表](#9-可调参数速查表)
10. [常见问题](#10-常见问题)

---

## 架构设计图

![鱼骨图组件架构设计](./fishbone-design.png)

---

## 1. 整体介绍

鱼骨图（又叫石川图、因果图）是一种用来分析问题根因的图表。整体形状像一条鱼：

```
                                    ┌─ 小骨
                            ┌─ 中骨 ┤
                    ┌─ 大骨 ┤        └─ 小骨
                    │       └─ 中骨
    鱼尾 ══════════╪══════════════════════════ 鱼头（问题）
                    │       ┌─ 中骨
                    └─ 大骨 ┤        ┌─ 小骨
                            └─ 中骨 ┤
                                      └─ 小骨
```

- **鱼头**：右侧，书写问题描述
- **主骨线**：水平中轴线
- **大骨**：从主骨线斜向上/下延伸，代表主要原因分类
- **中骨**：从大骨斜线上水平向左延伸，代表具体原因
- **小骨**：从中骨方框左侧延伸，代表更细的子原因（数量无限制）
- **鱼尾**：左侧装饰

---

## 2. 技术栈

| 技术 | 作用 |
|------|------|
| **Vue 3** (Composition API + `<script setup>`) | 组件框架 |
| **@antv/x6 v3** | 绘制线条(edge)和矩形节点(node) |
| **Arco Design Vue** | UI 组件（按钮、图标、单选框等） |

### 为什么用 X6？

X6 擅长画连线图，我们用它来：
- 画直线（主骨、大骨斜线、中骨水平线）
- 画矩形节点（加号按钮）

**重要**：骨骼标签不用 X6 节点，而是用 HTML overlay，这样才能支持 hover 编辑。

---

## 3. 文件结构

```
MyFishboneDiagram/
├── index.vue          # 主组件，包含所有业务逻辑
├── layout.js          # 布局计算模块
├── drawer.js          # 绘图辅助模块
└── README.md          # 本文档
```

### 3.1 index.vue（主组件，约 640 行）

这是核心文件，包含：
- 数据定义（`fishData`、`headLabel`）
- 骨骼增删函数（`addBigBone`、`addMidBone`、`addSmallBone`、`deleteBone`）
- 渲染入口（`renderGraph`）
- 交互处理（拖拽、缩放、hover编辑）
- 模板和样式

### 3.2 layout.js（布局计算，约 380 行）

负责计算所有骨骼的坐标位置，包括：
- 大骨斜线长度
- 中骨间距
- 画布尺寸
- 边界计算

### 3.3 drawer.js（绘图辅助，约 165 行）

提供绘图工具函数：
- `addEdge` - 画直线
- `addCurvedEdge` - 画贝塞尔弧线
- `addLabelNode` - 添加标签节点
- `addBtn` - 添加加号按钮

---

## 4. 数据结构

整个鱼骨图的数据存储在一个 Vue `reactive` 对象中：

```js
const fishData = reactive({
  bigBones: [
    {
      id: 'n_1',                    // 唯一标识（自动生成）
      label: '大骨 1',              // 显示文本
      position: 'top',              // 'top'=主骨线上方, 'bottom'=下方
      midBones: [
        {
          id: 'n_2',
          label: '中骨 1',
          smallBones: [
            { id: 'n_3', label: '小骨 1' },
            { id: 'n_4', label: '小骨 2' },
          ]
        }
      ]
    }
  ]
})
```

**关键点**：
- 这是一棵三层树：大骨 → 中骨 → 小骨
- `position` 自动分配：偶数索引在上，奇数在下
- 小骨数量没有限制
- 每次增/删骨骼后调用 `renderGraph()` 重绘整个图

---

## 5. 核心流程

### 5.1 渲染流程

```
用户操作（加骨/删骨/改标签）
  ↓
修改 fishData
  ↓
调用 renderGraph()
  ↓
① 销毁旧 X6 Graph
② 计算布局（每根骨骼的坐标）
③ 创建新 X6 Graph
④ 绘制线条和按钮节点
⑤ 生成编辑 overlay 数据（由 Vue 渲染为 HTML）
```

### 5.2 组件初始化

```js
// 父组件调用
const fishboneRef = ref(null)
fishboneRef.value.init(data)  // data 可选，不传则渲染空图
```

### 5.3 获取数据

```js
// 获取当前数据（不含 id，可用于保存）
const data = fishboneRef.value.getData()
```

---

## 6. 布局算法详解

![鱼骨图布局算法](./fishbone-layout-algo.png)

这是整个组件最复杂的部分。下面一步步拆解。

### 6.1 坐标系

- 原点在画布左上角
- X 轴向右为正
- Y 轴向下为正
- 主骨线在 `Y = CY`（默认 350px）处水平延伸
- 鱼头在右，鱼尾在左

### 6.2 大骨斜线长度 `calcDiag(b)`

大骨是一条 45° 的斜线。它的长度取决于有多少中骨：

```
斜线长度 = 顶端留白(headMargin) + Σ 中骨间距(midBoneSpan) + 底端留白(tailMargin)
```

因为斜线是 45°，在 X 轴和 Y 轴的投影相等：`dd = diag / √2`

### 6.3 中骨间距 `midBoneSpan(m)`

每根中骨沿斜线方向占用的空间。需要足够容纳其小骨群的垂直高度：

```
所需高度 = max(中骨自身高度 + 20, 小骨总高度 + 中骨高度)
斜线间距 = 所需高度 × √2  （因为 45° 需要补偿）
```

### 6.4 中骨横向长度 `calcDynamicMidLen(m)`

中骨水平线向左延伸的长度，根据小骨数量动态调整：

```
中骨长度 = MID_LEN(90px) + 小骨总高度 / 2
```

这样可以避免小骨数量很多时与中骨发生碰撞。

### 6.5 大骨分组

大骨按添加顺序每两根为一组（第1根在上，第2根在下）。组从鱼头向鱼尾排列：

```
鱼尾 ←── 第3组 ── 第2组 ── 第1组 ──→ 鱼头
           ↑↓       ↑↓       ↑↓
         大骨5,6   大骨3,4   大骨1,2
```

### 6.6 鱼头固定距离

**关键设计决策**：鱼头到第一组大骨节点的距离是动态计算的，确保大骨始终在鱼尾方向扩展，不会把鱼头推远。

---

## 7. 编辑交互

### 7.1 两种模式

- **编辑模式** (`mode = 'edit'`)：显示加号按钮，hover 骨骼标签变为 input
- **详情模式** (`mode = 'view'`)：只显示文本，不可交互

切换方式：底部操作栏的单选按钮

### 7.2 Hover 编辑原理

骨骼标签不用 X6 节点渲染，而是用 HTML `<div>` 覆盖在画布上方（editOverlays 数组）。

```
鼠标移入 → hoveringOverlayId = ov.id → v-if 切换为 <input> → 自动聚焦
鼠标移出 → hoveringOverlayId = null → v-if 切换回 <div> → 重绘画布
```

这样做的好处：
- 编辑框与文本标签完全重叠，视觉无跳动
- 背景色与骨骼颜色一致，看不出是 input

### 7.3 鱼头编辑

鱼头用同样的 hover 原理，直接写在 template 中。

### 7.4 删除骨骼

每个骨骼标签右上角都有一个红色 × 按钮，点击即可删除该骨骼。

---

## 8. 画布平移与缩放

### 8.1 原理

不使用 X6 自带的平移/缩放，而是用 CSS `transform: translate(panX, panY) scale(scale)` 控制整个世界容器。

**为什么这么做？** 因为我们在 X6 画布上叠加了 HTML overlay（编辑框、鱼头、鱼尾），X6 的缩放只能缩放画布内的元素，无法同步缩放外部 HTML。用 CSS transform 可以一次性缩放所有内容。

### 8.2 拖拽平移

```
pointerdown → 记录起始位置
pointermove → panX/panY += 鼠标偏移
pointerup   → 结束拖拽
```

### 8.3 滚轮缩放

以鼠标位置为缩放中心点。数学公式：

```
newPan = mousePos - (mousePos - oldPan) × (newScale / oldScale)
```

这保证鼠标指向的画布位置在缩放前后不变。

---

## 9. 可调参数速查表

### 9.1 全局常量（在 layout.js 中）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `LINE_CHARS` | 10 | 每行最多字符数（超过则换行） |
| `BIG_GAP` | 100 | 大骨最小宽度 |
| `DIAG` | 150 | 大骨斜线默认长度（无中骨时） |
| `MID_LEN` | 90 | 中骨水平线基础长度 |
| `PAIR_GAP` | 60 | 同组上下大骨的主骨线间距 |
| `PAD_L` | 70 | 画布左侧留白 |
| `TAIL` | 50 | 鱼尾到主骨线起点的距离 |
| `CY` | 350 | 主骨线的 Y 坐标 |
| `MAX_CHARS` | 20 | 标签最大字符数 |

### 9.2 内部常量（在 layout.js 的 calculateLayout 函数中）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `GROUP_GAP` | 30 | 相邻大骨组基础间距 |
| `HEAD_TO_FIRST_BONE` | 0 | 鱼头到第一组的距离（极小） |
| `FISH_SCALE_BASE` | 1.6 | 鱼头鱼尾基础缩放 |
| `FISH_SCALE_MAX` | 2.5 | 鱼头鱼尾最大缩放 |
| `SM_BOX_MIN_W` | 80 | 小骨方框最小宽度 |
| `MID_BOX_MIN_W` | 100 | 中骨方框最小宽度 |
| `BIG_BOX_MIN_W` | 120 | 大骨方框最小宽度 |

### 9.3 颜色配置（在 drawer.js 中）

```js
export const BONE_COLORS = [
  '#E96F56', '#668FF5', '#00A0C8', '#BB8C00', '#00A68D',
]
```

大骨颜色按添加顺序循环使用。

---

## 10. 常见问题

### Q1: 如何添加新的骨骼？

```js
addBigBone()                    // 新增大骨
addMidBone(bigId)              // 在指定大骨下新增中骨
addSmallBone(bigId, midId)     // 在指定中骨下新增小骨
```

### Q2: 如何删除骨骼？

每个骨骼标签右上角都有红色 × 按钮，点击即可删除。

### Q3: 如何修改骨骼标签？

将鼠标悬停在骨骼标签上，标签会自动变为输入框，直接编辑即可。

### Q4: 如何限制小骨数量？

当前版本已取消小骨数量限制，可以无限添加。

### Q5: 如何调整骨骼间距？

修改 `layout.js` 中的对应常量：
- 中骨间距：修改 `midBoneSpan` 函数逻辑
- 大骨间距：修改 `PAIR_GAP` 或 `GROUP_GAP`

### Q6: 如何添加新的骨骼颜色？

在 `drawer.js` 的 `BONE_COLORS` 数组中添加新颜色。

---

## 附录：关键函数索引

### 数据操作

| 函数 | 作用 |
|------|------|
| `addBigBone()` | 新增大骨 |
| `addMidBone(bigId)` | 在指定大骨下新增中骨 |
| `addSmallBone(bigId, midId)` | 在指定中骨下新增小骨 |
| `deleteBone(delInfo)` | 删除任意骨骼 |

### 布局计算（在 layout.js 中）

| 函数 | 作用 |
|------|------|
| `calculateLayout(fishData)` | 布局计算入口，返回所有布局信息 |
| `calcDiag(b)` | 计算大骨斜线总长度 |
| `midBoneSpan(m)` | 中骨沿斜线方向的间距 |
| `calcDynamicMidLen(m)` | 动态计算中骨横向长度 |
| `boneLeftExtent(b)` | 大骨向左延伸的最大距离 |
| `totalSmallBonesH(m)` | 小骨群总高度 |

### X6 绘图（在 drawer.js 中）

| 函数 | 作用 |
|------|------|
| `addEdge(s, t, color, w)` | 画直线 |
| `addCurvedEdge(s, t, color, w)` | 画贝塞尔弧线（小骨连线） |
| `addLabelNode(...)` | 添加标签节点或编辑 overlay |
| `addBtn(...)` | 添加加号按钮 |

### 交互（在 index.vue 中）

| 函数 | 作用 |
|------|------|
| `renderGraph()` | 核心：清除旧画布 → 计算布局 → 重新绘制 |
| `onPointerDown/Move/Up` | 画布拖拽 |
| `onWheel` | 滚轮缩放 |
| `onOverlayMouseEnter/Leave` | hover 切换编辑 |
