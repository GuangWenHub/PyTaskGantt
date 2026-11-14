import { RUN_STATUS_COLORS } from './runStatusColors.mjs'
export function normalizeMachineColor(value) {
  const color = String(value || '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(color) ? color : null
}
function oklab(hex) {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  const [r, g, b] = rgb
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
  return [.2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s]
}
const reserved = [...new Set(Object.values(RUN_STATUS_COLORS))].map(oklab)
export function machineColorError(value) {
  const color = normalizeMachineColor(value)
  if (!color) return '请输入六位颜色值，例如 #B7791F'
  const lab = oklab(color)
  if (reserved.some(other => {
    const distance = Math.hypot(...lab.map((part, index) => part - other[index]))
    return distance < .075
  })) return '此颜色与运行状态的蓝、绿、红或灰色过于接近，请换一个颜色'
  return ''
}
