import { ref, nextTick } from 'vue'

const MAX_CHARS = 20

export function useOverlayEdit({ mode, editOverlays, renderGraph }) {
  const hoveringOverlayId = ref(null)
  const originalLabel = ref('')

  function onOverlayBlur() {
    // blur 不主动清 hoveringOverlayId，交给 mouseLeave 统一处理
    // 仅当值变化时才重绘（blur 可能先于 mouseLeave 触发）
  }

  function onOverlayInput(e, ov) {
    const val = e.target.value
    if (val.length > MAX_CHARS) {
      e.target.value = val.slice(0, MAX_CHARS)
      ov.boneRef.label = e.target.value
    } else {
      ov.boneRef.label = val
    }
  }

  function onOverlayMouseEnter(ov) {
    if (mode.value === 'edit') {
      originalLabel.value = ov.boneRef.label
      hoveringOverlayId.value = ov.id
      nextTick(() => {
        const el = document.querySelector(`#edit-input-${ov.id}`)
        if (el) el.focus()
      })
    }
  }

  function onOverlayMouseLeave(ov) {
    if (hoveringOverlayId.value === ov.id) {
      const changed = ov.boneRef.label !== originalLabel.value
      hoveringOverlayId.value = null
      if (changed) renderGraph()
    }
  }

  function getDisplayLabel(text) {
    let label = text || ''
    if (label.length > 20) label = label.slice(0, 20)
    if ((mode.value === 'view' || mode.value === 'edit') && label.length > 10) {
      return label.slice(0, 10) + '\n' + label.slice(10)
    }
    return label
  }

  function deleteBone(delInfo, fishData) {
    if (!delInfo) return
    const { type, bigId, midId, smId } = delInfo
    if (type === 'big') {
      const idx = fishData.bigBones.findIndex((b) => b.id === bigId)
      if (idx >= 0) fishData.bigBones.splice(idx, 1)
      fishData.bigBones.forEach((b, i) => {
        b.position = i % 2 === 0 ? 'top' : 'bottom'
      })
    } else if (type === 'mid') {
      const big = fishData.bigBones.find((b) => b.id === bigId)
      if (!big) return
      const idx = big.midBones.findIndex((m) => m.id === midId)
      if (idx >= 0) big.midBones.splice(idx, 1)
    } else if (type === 'small') {
      const big = fishData.bigBones.find((b) => b.id === bigId)
      if (!big) return
      const mid = big.midBones.find((m) => m.id === midId)
      if (!mid) return
      const idx = mid.smallBones.findIndex((s) => s.id === smId)
      if (idx >= 0) mid.smallBones.splice(idx, 1)
    }
    renderGraph()
  }

  return {
    MAX_CHARS,
    hoveringOverlayId,
    onOverlayBlur,
    onOverlayInput,
    onOverlayMouseEnter,
    onOverlayMouseLeave,
    getDisplayLabel,
    deleteBone,
  }
}
