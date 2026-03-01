/**
 * 鱼骨图绘图辅助模块
 * 负责：节点/边的绘制、按钮创建等
 */

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════
const BTN = 24  // 默认按钮大小

/**
 * 创建绘图器
 * @param {Object} options - 依赖注入
 * @param {Object} options.graph - X6 Graph 实例
 * @param {Object} options.mode - Vue ref: 'edit' | 'view'
 * @param {Object} options.editOverlays - Vue ref: 编辑层数组
 * @param {Object} options.callbackMap - 回调函数映射
 * @param {number} options.LINE_CHARS - 每行最大字符数
 * @returns {Object} 绘图函数集合
 */
export function createDrawer({ graph, mode, editOverlays, callbackMap, LINE_CHARS }) {

  /** 添加一条直线边（无箭头） */
  function addEdge(s, t, color, w) {
    const none = { tagName: 'path', d: '' }
    graph.addEdge({
      shape: 'edge',
      source: { x: s[0], y: s[1] },
      target: { x: t[0], y: t[1] },
      attrs: {
        line: {
          stroke: color, strokeWidth: w, strokeLinecap: 'round',
          targetMarker: none, sourceMarker: none,
        },
      },
    })
  }

  /**
   * 添加一条贝塞尔弧线（用于多小骨的大括号连线）。
   * 用自定义 SVG <path> 节点实现，不依赖 X6 的 connector，
   * 这样可以精确控制弧线两端水平出入的方向。
   *
   * 控制点 cpX = 65% 的水平距离，确保：
   *   - 从起点水平出发（像大括号的根部）
   *   - 到终点水平到达（像大括号的枝端）
   */
  function addCurvedEdge(s, t, color, w) {
    const x1 = Math.min(s[0], t[0])
    const y1 = Math.min(s[1], t[1])
    const padW = Math.abs(t[0] - s[0]) + 4
    const padH = Math.max(Math.abs(t[1] - s[1]), 2) + 4
    const ox = x1 - 2, oy = y1 - 2
    const sx = s[0] - ox, sy = s[1] - oy
    const tx = t[0] - ox, ty = t[1] - oy
    const cpX = Math.abs(t[0] - s[0]) * 0.65
    const d = `M ${sx} ${sy} C ${sx - cpX} ${sy}, ${tx + cpX} ${ty}, ${tx} ${ty}`
    graph.addNode({
      shape: 'rect',
      x: ox, y: oy,
      width: padW, height: padH,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'path', selector: 'curve' },
      ],
      attrs: {
        body: { fill: 'transparent', stroke: 'none', pointerEvents: 'none' },
        curve: { d, fill: 'none', stroke: color, strokeWidth: w, strokeLinecap: 'round' },
      },
    })
  }

  /**
   * 添加带文本的矩形节点。
   * 编辑模式下不画 X6 节点，而是把信息推入 editOverlays 数组，
   * 由 Vue template 渲染为可交互的 HTML overlay。
   *
   * @param growDir  文本超长时方框的扩展方向：-1=向上扩展, 1=向下, 0=居中扩展
   */
  function addLabelNode(
    id, x, y, w, h, text, bg, border, fg,
    fs = 12, fw = 500, rx = 4, boneRef = null, delInfo = null, growDir = 0,
  ) {
    const boneType = delInfo?.type || ''
    const lineH = Math.round(fs * 1.5)
    const needTwoLines = text.length > LINE_CHARS
    const displayH = needTwoLines ? lineH * 2 + 6 : h
    let displayY = y
    if (needTwoLines) {
      const extra = displayH - h
      if (growDir === -1) displayY = y - extra
      else if (growDir === 1) displayY = y
      else displayY = y - extra / 2
    }
    if (mode.value === 'edit' && boneRef) {
      editOverlays.value.push({
        id, x, y: displayY, w, h: displayH,
        boneRef, bg, border, fg, fs, fw, rx, delInfo, boneType,
      })
    } else {
      graph.addNode({
        id, shape: 'rect',
        x, y: displayY, width: w, height: displayH,
        attrs: {
          body: { fill: bg, stroke: border, strokeWidth: 1.2, rx, ry: rx },
          label: {
            text, fill: fg, fontSize: fs, fontWeight: fw,
            textWrap: { width: w - 12, height: displayH - 4, ellipsis: true },
          },
        },
      })
    }
  }

  /** 添加加号按钮节点（仅编辑模式可见） */
  function addBtn(id, x, y, color, tip, fn, size) {
    if (mode.value !== 'edit') return
    const s = size || BTN
    callbackMap[id] = fn
    graph.addNode({
      id, shape: 'rect', x, y, width: s, height: s,
      attrs: {
        body: { fill: color, stroke: '#fff', strokeWidth: 1.5, rx: 4, ry: 4, cursor: 'pointer' },
        label: {
          text: '+', fill: '#fff',
          fontSize: s === BTN ? 16 : 13,
          fontWeight: 'bold', cursor: 'pointer',
        },
      },
    })
  }

  return {
    addEdge,
    addCurvedEdge,
    addLabelNode,
    addBtn,
    BTN,
  }
}

/**
 * 颜色配置
 */
export const BONE_COLORS = [
  '#E96F56', '#668FF5', '#00A0C8', '#BB8C00', '#00A68D',
]

/**
 * 获取大骨颜色
 */
export function getBoneColor(bigIndex) {
  return BONE_COLORS[bigIndex % BONE_COLORS.length]
}

/**
 * 将 hex 颜色转为指定透明度的 rgba（用于方框浅色背景）
 */
export function lightenColor(hex, alpha = 0.12) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
