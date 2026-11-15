// Dev-time tool: turns a portrait photo into the whacker's pixel head.
//   node head.mjs <photo.jpg> [preview.png]
// Needs ffmpeg. Writes head.json (rows of palette letters, '.' is empty) next
// to this file; build.mjs reads that, so building the theme needs no photo.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [photo, preview] = process.argv.slice(2)
// The head's box in the photo, and its outline as a polygon, in photo pixels.
const BOX = [65, 0, 335, 322]
const OUTLINE = [
  [125, 4], [200, 0], [280, 5], [315, 35], [330, 75], [325, 115], [312, 145], [318, 160], [316, 220],
  [300, 235], [295, 270], [280, 300], [250, 314], [215, 320], [175, 308], [150, 290], [136, 250],
  [131, 230], [108, 220], [98, 175], [108, 165], [100, 145], [80, 115], [70, 85], [75, 45], [95, 20],
]
const W = 34
const H = 40
const COLORS = 18

const raw = execFileSync(
  'ffmpeg',
  ['-v', 'error', '-i', photo, '-vf', `crop=${BOX[2] - BOX[0]}:${BOX[3] - BOX[1]}:${BOX[0]}:${BOX[1]},eq=contrast=1.12:saturation=1.25,scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1e8 },
)
const inside = (x, y) => {
  // Even-odd test of the cell's center against the outline.
  const px = BOX[0] + ((x + 0.5) / W) * (BOX[2] - BOX[0])
  const py = BOX[1] + ((y + 0.5) / H) * (BOX[3] - BOX[1])
  let isIn = false
  for (let i = 0, j = OUTLINE.length - 1; i < OUTLINE.length; j = i++) {
    const [xi, yi] = OUTLINE[i]
    const [xj, yj] = OUTLINE[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) isIn = !isIn
  }
  return isIn
}
const cells = []
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    cells.push(inside(x, y) ? [raw[(y * W + x) * 3], raw[(y * W + x) * 3 + 1], raw[(y * W + x) * 3 + 2]] : null)

// k-means over the head's own pixels, seeded evenly along their brightness.
const solid = cells.filter(Boolean)
const light = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
const far = (a, b) => 0.3 * (a[0] - b[0]) ** 2 + 0.59 * (a[1] - b[1]) ** 2 + 0.11 * (a[2] - b[2]) ** 2
const ordered = [...solid].sort((a, b) => light(a) - light(b))
let centers = Array.from({ length: COLORS }, (_, k) => [...ordered[Math.floor(((k + 0.5) / COLORS) * ordered.length)]])
const nearest = c => centers.reduce((best, center, k) => (far(c, center) < far(c, centers[best]) ? k : best), 0)
for (let round = 0; round < 40; round++) {
  const groups = centers.map(() => [])
  solid.forEach(c => groups[nearest(c)].push(c))
  centers = centers.map((center, k) =>
    groups[k].length === 0 ? center : [0, 1, 2].map(ch => Math.round(groups[k].reduce((sum, c) => sum + c[ch], 0) / groups[k].length)),
  )
}
const letters = 'abcdefghijklmnopqrstuvwxyz'
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
const palette = Object.fromEntries(centers.map((c, k) => [letters[k], hex(c)]))
const rows = []
for (let y = 0; y < H; y++) {
  let row = ''
  for (let x = 0; x < W; x++) {
    const c = cells[y * W + x]
    row += c ? letters[nearest(c)] : '.'
  }
  rows.push(row)
}
fs.writeFileSync(path.join(here, 'head.json'), JSON.stringify({ rows, palette }, null, 1) + '\n')

if (preview) {
  const body = Buffer.alloc(W * H * 3)
  rows.forEach((row, y) =>
    [...row].forEach((letter, x) => {
      const c = letter === '.' ? [40, 90, 60] : centers[letters.indexOf(letter)]
      body.set(c, (y * W + x) * 3)
    }),
  )
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-', '-vf', `scale=${W * 10}:${H * 10}:flags=neighbor`, preview], { input: body })
}
