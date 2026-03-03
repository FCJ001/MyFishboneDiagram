import { BTN_SIZE } from './layout'

// 创建绘图器
export function createDrawer({ graph, mode, editOverlays, callbackMap, LINE_CHARS }) {

  // 添加直线边
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

  // 添加贝塞尔弧线（用于小骨分叉）
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

  // 添加标签节点
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

    // 有 boneRef 时走 overlay 渲染
    if (boneRef) {
      editOverlays.value.push({
        id, x, y: displayY, w, h: displayH,
        boneRef, bg, border, fg, fs, fw, rx, delInfo, boneType,
      })
      return
    }

    // 无 boneRef 时用 X6 节点
    graph.addNode({
      id,
      shape: 'rect',
      x,
      y: displayY,
      width: w,
      height: displayH,
      attrs: {
        body: { fill: bg, stroke: border, strokeWidth: 1.2, rx, ry: rx },
        label: {
          text,
          fill: fg,
          fontSize: fs,
          fontWeight: fw,
        },
      },
    })
  }

  // 添加加号按钮（编辑模式可见）
  function addBtn(id, x, y, color, tip, fn, size) {
    if (mode.value !== 'edit') return
    const s = size || BTN_SIZE
    callbackMap[id] = fn
    graph.addNode({
      id, shape: 'rect', x, y, width: s, height: s,
      attrs: {
        body: { fill: color, stroke: '#fff', strokeWidth: 1.5, rx: 4, ry: 4, cursor: 'pointer' },
        label: {
          text: '+', fill: '#fff',
          fontSize: s === BTN_SIZE ? 16 : 13,
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
    BTN_SIZE,
  }
}

// 大骨颜色数组（循环使用）
export const BONE_COLORS = [
  '#B37DD8', '#6C9E42', '#D77D1E', '#8793B9', '#CE75B8',
  '#668FF5', '#00A0C8', '#BB8C00', '#00A68D', '#E96F56',
]

// 获取大骨颜色
export function getBoneColor(bigIndex) {
  return BONE_COLORS[bigIndex % BONE_COLORS.length]
}

// 颜色提亮（生成浅色背景）
export function lightenColor(hex, alpha = 0.12) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
