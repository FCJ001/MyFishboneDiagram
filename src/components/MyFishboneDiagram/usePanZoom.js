import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

export function usePanZoom({ viewportRef, isFirstRender, baseScale }) {
  const panX = ref(0)
  const panY = ref(0)
  const scale = ref(1)
  const SCALE_MIN = 0.001
  const SCALE_MAX = 1000

  let isPanning = false
  let panStartX = 0
  let panStartY = 0
  let panOriginX = 0
  let panOriginY = 0
  let didDrag = false

  const displayScale = computed(() => {
    if (isFirstRender.value) return 100
    return Math.round(scale.value / baseScale.value * 100)
  })

  function onPointerDown(e) {
    if (e.target.closest('.inline-edit-wrap') || e.target.closest('.fish-head-label')) return
    isPanning = true
    didDrag = false
    panStartX = e.clientX
    panStartY = e.clientY
    panOriginX = panX.value
    panOriginY = panY.value
    viewportRef.value.style.cursor = 'grabbing'
  }

  function onPointerMove(e) {
    if (!isPanning) return
    const dx = e.clientX - panStartX
    const dy = e.clientY - panStartY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true
    panX.value = panOriginX + dx
    panY.value = panOriginY + dy
  }

  function onPointerUp() {
    if (!isPanning) return
    isPanning = false
    if (viewportRef.value) viewportRef.value.style.cursor = ''
  }

  function onWheel(e) {
    e.preventDefault()
    const rect = viewportRef.value.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const oldScale = scale.value
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, oldScale + delta))
    panX.value = mx - (mx - panX.value) * (newScale / oldScale)
    panY.value = my - (my - panY.value) * (newScale / oldScale)
    scale.value = newScale
  }

  function zoomIn() {
    scale.value = Math.min(SCALE_MAX * baseScale.value, scale.value + 0.1 * baseScale.value)
  }

  function zoomOut() {
    scale.value = Math.max(SCALE_MIN * baseScale.value, scale.value - 0.1 * baseScale.value)
  }

  function getDidDrag() { return didDrag }

  onMounted(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  })

  return {
    panX, panY, scale, displayScale,
    SCALE_MIN, SCALE_MAX,
    onPointerDown, onWheel,
    zoomIn, zoomOut, getDidDrag,
  }
}
