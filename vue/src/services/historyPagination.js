// Keep each row at its natural content height. Only whole rows move to the next
// page; the remaining space is always smaller than the next row (except at end).
export function fitHistoryPages(records, heights, availableHeight) {
  const pages = []
  let current = []
  let used = 0
  records.forEach((record, index) => {
    const height = heights[index]
    if (current.length && used + height > availableHeight) {
      pages.push(current)
      current = []
      used = 0
    }
    current.push(record)
    used += height
  })
  if (current.length) pages.push(current)
  return pages
}
