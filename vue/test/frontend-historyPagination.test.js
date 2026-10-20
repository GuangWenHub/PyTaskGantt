import { describe, expect, it } from 'vitest'
import { fitHistoryPages } from '../src/services/historyPagination.js'

describe('按实际内容高度分页', () => {
  it('短行继续填入当前页，长行整体移到下一页，不拉高已有行', () => {
    const records = ['短行甲', '长行', '短行乙', '有备注', '短行丙']
    const heights = [62, 121, 68, 104, 60]
    const pages = fitHistoryPages(records, heights, 260)
    expect(pages).toEqual([['短行甲', '长行', '短行乙'], ['有备注', '短行丙']])
    expect(pages.flat()).toEqual(records)
    // First page leaves only 9px; another complete row cannot fit.
    expect(260 - (62 + 121 + 68)).toBe(9)
  })

  it('尺寸变化重新分页，恰好放下不换页，没有记录不造空白行', () => {
    expect(fitHistoryPages([1, 2, 3], [80, 90, 100], 170)).toEqual([[1, 2], [3]])
    expect(fitHistoryPages([1, 2, 3], [80, 90, 100], 270)).toEqual([[1, 2, 3]])
    expect(fitHistoryPages([], [], 270)).toEqual([])
  })
})
