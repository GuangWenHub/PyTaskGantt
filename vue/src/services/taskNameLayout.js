// Read text rectangles rather than the content box: vis stretches that box to the full task width.
export function taskNameOffset(content, anchorX, viewport, fallbackText = '') {
  if (content?.isConnected) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    const rights = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects?.() || []) {
        if (rect.width > 0 && rect.right > viewport.left && rect.left < viewport.right) rights.push(Math.min(rect.right, viewport.right))
      }
    }
    if (rights.length) return Math.max(4, Math.max(...rights) - anchorX + 4)
    return 4
  }
  // First paint precedes vis DOM creation. Reserve each full emoji grapheme until the measured paint.
  const text = document.createElement('span')
  text.innerHTML = fallbackText
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.textContent || '')]
  return parts.length ? 10 + parts.reduce((width, { segment }) => width + (/\p{Extended_Pictographic}/u.test(segment) ? 18 : 8), 0) : 4
}
