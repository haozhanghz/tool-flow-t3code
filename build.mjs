// Builds tool-flow for T3 Code: one theme file, `tool-flow.json`.
//
//   node build.mjs
//
// A T3 Code theme is colors plus CSS, and the CSS may not load files or run
// script. So the whole game is CSS:
//
// - T3 Code shows what the agent is doing right now in one "live" row of the
//   chat, with an icon for the kind of tool. `:has()` reads that icon, and
//   that is how a mole knows to come up.
// - Each mole's height and each whack's clock is a registered custom property.
//   A property that transitions is the animation: a mole rises when its kind
//   of tool shows, and when it stops showing, a clock runs from 0 to 1 and the
//   mallet, the stars and what flies out are all placed from that clock.
// - Every sprite is a small PNG in a `data:` address, all of them layers of
//   one pseudo-element's background, moved by `calc()`.
//
// Nothing is read from the page but that icon, and nothing leaves it.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---- Pixel canvases and PNG ---------------------------------------------------

class Pix {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.cells = new Array(width * height).fill(null)
  }

  set(x, y, color) {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.cells[y * this.width + x] = color
  }

  get(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.cells[y * this.width + x] : null
  }

  // Rows of letters, one letter a pixel, each pixel drawn `scale` cells wide.
  draw(rows, palette, ox = 0, oy = 0, scale = 1) {
    rows.forEach((row, y) =>
      [...row].forEach((letter, x) => {
        const color = palette[letter]

        if (color === undefined) return
        for (let dy = 0; dy < scale; dy += 1)
          for (let dx = 0; dx < scale; dx += 1) this.set(ox + x * scale + dx, oy + y * scale + dy, color)
      }),
    )

    return this
  }

  rect(x, y, width, height, color) {
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) this.set(x + dx, y + dy, color)

    return this
  }

  blit(source, ox = 0, oy = 0) {
    for (let y = 0; y < source.height; y += 1)
      for (let x = 0; x < source.width; x += 1) {
        const color = source.get(x, y)

        if (color !== null) this.set(ox + x, oy + y, color)
      }

    return this
  }

  // `source` turned by `degrees` (clockwise) about its own point (px, py),
  // with that point put at (ox, oy) here.
  blitTurned(source, degrees, px, py, ox, oy) {
    const angle = (degrees * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    for (let y = 0; y < this.height; y += 1)
      for (let x = 0; x < this.width; x += 1) {
        const dx = x + 0.5 - ox
        const dy = y + 0.5 - oy
        const color = source.get(Math.floor(px + dx * cos + dy * sin), Math.floor(py - dx * sin + dy * cos))

        if (color !== null) this.set(x, y, color)
      }

    return this
  }

  // A one-cell line around everything drawn so far.
  outlined(color) {
    const next = new Pix(this.width + 2, this.height + 2)

    for (let y = -1; y <= this.height; y += 1)
      for (let x = -1; x <= this.width; x += 1) {
        if (this.get(x, y) !== null) continue
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.get(x + dx, y + dy) !== null)) {
          next.set(x + 1, y + 1, color)
        }
      }

    return next.blit(this, 1, 1)
  }

  png() {
    const colors = [...new Set(this.cells.filter(cell => cell !== null))]
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data])
      const size = Buffer.alloc(4)
      const sum = Buffer.alloc(4)

      size.writeUInt32BE(data.length)
      sum.writeUInt32BE(zlib.crc32(body))

      return Buffer.concat([size, body, sum])
    }
    const head = Buffer.alloc(13)

    head.writeUInt32BE(this.width, 0)
    head.writeUInt32BE(this.height, 4)
    // Eight bits a pixel, each an index into the palette; index 0 is empty.
    head.set([8, 3, 0, 0, 0], 8)

    const palette = Buffer.from([0, 0, 0, ...colors.flatMap(color => [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)))])
    const lines = Buffer.alloc((this.width + 1) * this.height)

    this.cells.forEach((cell, index) => {
      const y = Math.floor(index / this.width)

      lines[y * (this.width + 1) + 1 + (index % this.width)] = cell === null ? 0 : colors.indexOf(cell) + 1
    })

    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('PLTE', palette),
      chunk('tRNS', Buffer.from([0])),
      chunk('IDAT', zlib.deflateSync(lines, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }

  url() {
    return `url("data:image/png;base64,${this.png().toString('base64')}")`
  }
}

// A vector sprite for the scenery, which is not in the game's pixelated layer.
function svgUrl(width, height, viewWidth, viewHeight, inner, extra = '') {
  const markup = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${viewWidth} ${viewHeight}'${extra}>${inner}</svg>`

  return `url("data:image/svg+xml,${markup.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`
}

function paths(rows, palette, ox = 0, oy = 0) {
  const runs = {}

  rows.forEach((row, y) => {
    let x = 0

    while (x < row.length) {
      const letter = row[x]
      let end = x + 1

      while (end < row.length && row[end] === letter) end += 1
      if (palette[letter] !== undefined) runs[letter] = (runs[letter] ?? '') + `M${ox + x} ${oy + y}h${end - x}v1h${x - end}z`
      x = end
    }
  })

  return Object.entries(runs)
    .map(([letter, d]) => `<path fill='${palette[letter]}' d='${d}'/>`)
    .join('')
}

// Day's colors as the night sees them: darker, and toward blue.
function atNight(markup) {
  return markup.replace(/#([0-9a-f]{6})/gi, (_, hex) => {
    const part = (at, share, lift) =>
      Math.min(255, Math.round(parseInt(hex.slice(at, at + 2), 16) * share + lift))
        .toString(16)
        .padStart(2, '0')

    return `#${part(0, 0.34, 6)}${part(2, 0.46, 10)}${part(4, 0.6, 28)}`
  })
}

function tint(hex, toWhite) {
  const part = at => {
    const value = parseInt(hex.slice(at, at + 2), 16)

    return Math.round(value + (255 - value) * toWhite)
      .toString(16)
      .padStart(2, '0')
  }

  return `#${part(1)}${part(3)}${part(5)}`
}

// ---- The moles ------------------------------------------------------------------

const INK = '#3b2416'
const DARK = '#111827'
const LANES = [
  { lane: 'read', color: '#2563eb', icons: ['svg.lucide-eye', 'svg.lucide-search'] },
  { lane: 'edit', color: '#d97706', icons: ['svg.lucide-square-pen'] },
  { lane: 'run', color: '#15803d', icons: ['svg.lucide-terminal', 'svg[class*="lucide-code"]'] },
  { lane: 'web', color: '#0891b2', icons: ['svg.lucide-globe', 'img'] },
  // A running subagent has no icon in the live row; its own row says "Running".
  { lane: 'agent', color: '#7c3aed', icons: ['svg.lucide-bot'], rows: ['[data-v2-item-type="subagent"][aria-description="Running"]'] },
  { lane: 'mcp', color: '#db2777', icons: ['svg.lucide-wrench', 'svg.lucide-smartphone', 'svg:not(.lucide)'] },
  { lane: 'other', color: '#475569', icons: ['svg.lucide-hammer', 'svg.lucide-zap', 'svg.lucide-list-todo', 'svg.lucide-message-circle'] },
]

const MOLE = [
  '....HHHHHHHH....',
  '...HhhHHHHHHH...',
  '..HHhHHHHHHHHH..',
  '..kkkkkkkkkkkk..',
  '.kbbbbbbbbbbbbk.',
  '.kbwwebbbbwwebk.',
  '.kbwwebbbbwwebk.',
  '.kbbbbbppbbbbbk.',
  '.kbbllbppbllbbk.',
  '.kbbllwwwwllbbk.',
  '.kbblllwwlllbbk.',
  '.kbbbllllllbbbk.',
  'kkbbbbbbbbbbbbkk',
  'klkbbbbbbbbbbklk',
  'kkkbbbbbbbbbbkkk',
  '..kbbbbbbbbbbk..',
]
// A mole's sprite has three rows above its head, for what it wears there.
const HAT = 3

function mole({ lane, color }) {
  const sprite = new Pix(16, 16 + HAT).draw(
    MOLE,
    { H: color, h: tint(color, 0.55), k: INK, b: '#9a6845', l: '#d9b48a', p: '#ff8fa3', w: '#ffffff', e: '#1b1b1f' },
    0,
    HAT,
  )
  const wear = (rows, palette, x, y) => sprite.draw(rows, palette, x, y + HAT)
  const held = { k: DARK, w: '#ffffff', g: '#94a3b8', y: '#f59e0b' }

  if (lane === 'read') {
    // Round glasses, and an open book.
    wear(['..kkkkk..kkkkk..', '..k...kkkk...k..', '..k...k..k...k..', '..kkkkk..kkkkk..'], { k: DARK }, 0, 4)
    wear(['..kkkkkkkkkkkk..', '..kwwwwkkwwwwk..', '..kwggwkkwggwk..', '..kwwwwkkwwwwk..', '..kkkkkkkkkkkk..'], held, 0, 10)
  } else if (lane === 'edit') {
    // A pencil behind the ear, and a pad.
    wear(['pp', 'yy', 'yy', 'yy', 'yy', 'nn', '.k'], { p: '#fb7185', y: '#fbbf24', n: '#fde68a', k: DARK }, 12, -3)
    wear(['...kkkkkkkkkk...', '...kwwwwwwwwk...', '...kwyywwyywk...', '...kwwyywwwwk...', '...kkkkkkkkkk...'], held, 0, 10)
  } else if (lane === 'run') {
    // A hard hat with a lamp.
    wear(['yyyyyyyyyyyyyy'], { y: '#facc15' }, 1, 3)
    wear(['ww', 'ww'], { w: '#fef9c3' }, 7, 0)
  } else if (lane === 'web') {
    // An aerial with a red tip.
    wear(['rr', 'rr', 'ss', 'ss'], { r: '#f43f5e', s: '#cbd5e1' }, 7, -3)
  } else if (lane === 'agent') {
    // A robot's visor and two feelers.
    wear(['k......k'], { k: '#c4b5fd' }, 4, -1)
    wear(['wwcccccccccc', 'wwcccccccccc'], { c: '#22d3ee', w: '#ffffff' }, 2, 5)
  } else if (lane === 'mcp') {
    // The two prongs of a plug.
    wear(['ss..ss', 'ss..ss', 'ss..ss'], { s: '#e2e8f0' }, 5, -3)
  } else {
    // A propeller cap.
    wear(['bbb..bbb', '...bb...', '...rr...'], { b: '#fbbf24', r: '#ef4444' }, 4, -3)
  }

  return sprite
}

// Drawn over a mole's eyes once the mallet has landed.
const DIZZY = new Pix(16, 16 + HAT).draw(['...kbk....kbk...', '...bkb....bkb...', '...kbk....kbk...'], { b: '#9a6845', k: INK }, 0, 4 + HAT)

// ---- A hole, on its patch of lawn ---------------------------------------------------

const TILE_W = 34
const TILE_H = 30
// The row of the patch where the near edge of the hole starts: everything from
// here down is drawn again over the mole, so a mole sinks behind it.
const LIP = 10
const DIRT = { m: '#a8774c', M: '#c99766', d: '#7d5536', k: '#24160f' }
const HOLE_BACK = [
  '....mmmmmmmmmmmmmmmmmm....',
  '..mmMMMMMMMMMMMMMMMMMMmm..',
  '.mmMMkkkkkkkkkkkkkkkkMMmm.',
  '.mMMkkkkkkkkkkkkkkkkkkMMm.',
  'mmMkkkkkkkkkkkkkkkkkkkkMmm',
  'mmMkkkkkkkkkkkkkkkkkkkkMmm',
]
const HOLE_FRONT = [
  'mmMMkkkkkkkkkkkkkkkkkkMMmm',
  'mmmMMMMMMMMMMMMMMMMMMMMmmm',
  '.mmmmmmmmmmmmmmmmmmmmmmmm.',
  '..ddmmmmmmmmmmmmmmmmmmdd..',
  '....dddddddddddddddddd....',
]

function tile({ lawn, rim, shine }) {
  const patch = new Pix(TILE_W, TILE_H)

  for (let y = 0; y < TILE_H; y += 1) {
    const inset = y === 0 || y === TILE_H - 1 ? 3 : y === 1 || y === TILE_H - 2 ? 1 : 0

    patch.rect(inset, y, TILE_W - inset * 2, 1, y >= TILE_H - 3 ? rim : y === 0 ? shine : lawn)
  }
  patch.draw(HOLE_BACK, DIRT, 4, LIP - 5)

  const front = new Pix(TILE_W, TILE_H - LIP)

  for (let y = LIP; y < TILE_H; y += 1) for (let x = 0; x < TILE_W; x += 1) front.set(x, y - LIP, patch.get(x, y))
  front.draw(HOLE_FRONT, DIRT, 4, 0)

  return { back: patch, front }
}

// ---- What flies out of a hole, one sprite for each kind of tool -------------------

const FX_W = 24
const FX_H = 18

function burst(lane) {
  const sprite = new Pix(FX_W, FX_H)
  const paper = ['wwww', 'wggw', 'wwww', 'wggw', 'wwww']
  const bolt = ['..yy', '.yy.', 'yyyy', '.yy.', 'yy..', 'y...']
  const plus = ['.y.', 'yyy', '.y.']
  const puff = ['.pp.', 'pppp', 'pppp', '.pp.']

  if (lane === 'read') {
    const sheet = { w: '#ffffff', g: '#94a3b8' }

    sprite.draw(paper, sheet, 2, 6).draw(paper, sheet, 10, 1).draw(paper, sheet, 18, 8)
  } else if (lane === 'edit') {
    sprite.draw(['y..p..y', '.y...p.', '..y.y..'], { y: '#f59e0b', p: '#fb7185' }, 2, 2)
    sprite.draw(['p.y', '.p.', 'y.p'], { y: '#fde047', p: '#fb7185' }, 17, 3)
    sprite.draw(['y.y.y.y.y', '.y.y.y.y.'], { y: '#f59e0b' }, 7, 11)
  } else if (lane === 'run') {
    const spark = { y: '#fde047' }

    sprite.draw(bolt, spark, 2, 5).draw(bolt, spark, 10, 0).draw(bolt, spark, 18, 6)
    sprite.draw(['g', '.'], { g: '#4ade80' }, 8, 12).rect(15, 13, 2, 2, '#4ade80').rect(5, 14, 2, 2, '#4ade80')
  } else if (lane === 'web') {
    // Rings: they widen as the sprite grows.
    sprite.draw(['...cccccccccccccc...', '.cc..............cc.', 'c..................c', 'c....wwwwwwwwww....c', 'c..ww..........ww..c', 'c..w............w..c', 'c..ww..........ww..c', 'c....wwwwwwwwww....c', 'c..................c', '.cc..............cc.', '...cccccccccccccc...'], { c: '#22d3ee', w: '#ffffff' }, 2, 3)
  } else if (lane === 'agent') {
    sprite.draw(plus, { y: '#fde047' }, 10, 0).draw(plus, { y: '#ffffff' }, 20, 6).draw(plus, { y: '#c4b5fd' }, 16, 14)
    sprite.draw(plus, { y: '#fde047' }, 4, 14).draw(plus, { y: '#ffffff' }, 0, 6)
  } else if (lane === 'mcp') {
    sprite.draw(['...p', '..p.', '.ppp', '..p.', '.p..', 'p...'], { p: '#f472b6' }, 1, 5)
    sprite.draw(['p...', '.p..', 'ppp.', '.p..', '..p.', '...p'], { p: '#f472b6' }, 19, 5)
    sprite.draw(['.y.', 'y..', '.y.', '..y'], { y: '#fde047' }, 8, 0).draw(['.y.', '..y', '.y.', 'y..'], { y: '#fde047' }, 13, 0)
  } else {
    const dust = { p: '#b9a488' }

    sprite.draw(puff, dust, 1, 8).draw(puff, dust, 18, 9).draw(puff, dust, 10, 3)
    sprite.draw(['.ss.', 'sSss', 'ssss', '.ss.'], { s: '#94a3b8', S: '#e2e8f0' }, 6, 12).rect(15, 13, 1, 4, '#94a3b8').rect(14, 13, 3, 1, '#cbd5e1')
  }

  return sprite
}

const POW = new Pix(13, 13).draw(
  ['......w......', '.w...www...w.', '..ww.wyw.ww..', '...wwyyyww...', '..wwyyyyyww..', '.wwyyyyyyyww.', 'wwyyyyoyyyyww', '.wwyyyyyyyww.', '..wwyyyyyww..', '...wwyyyww...', '..ww.wyw.ww..', '.w...www...w.', '......w......'],
  { w: '#ffffff', y: '#fde047', o: '#fb923c' },
)

// ---- The one with the mallet -------------------------------------------------------
//
// Drawn on a grid half as coarse as the moles', so the head keeps its likeness.
// The head comes from `art/head.json`, which `art/head.mjs` makes from a photo.

const MALLET = [
  '.kkkkkkkk.',
  'kRRRrRRRRk',
  'kRRRrRRRRk',
  'kWWWwWWWWk',
  'kRRRrRRRRk',
  '.kkkkkkkk.',
  ...Array.from({ length: 14 }, () => '....nN....'),
]
const MALLET_COLORS = { k: INK, R: '#e5484d', r: '#ff8a8e', W: '#ffffff', w: '#f1f5f9', n: '#8a5a3c', N: '#b98a5e' }
const WHO_W = 100
const WHO_H = 66
// Where the figure stands in its own sprite, and where its mallet hand is.
const FEET = { x: 70, y: 65 }
const HAND = { x: 56, y: 51 }
const OUTLINE = '#17110d'

// `lift` raises the mallet hand, for the moment before the mallet comes down.
function whacker(degrees, isLeaning, lift = 0) {
  const sprite = new Pix(WHO_W, WHO_H)
  const head = JSON.parse(fs.readFileSync(path.join(here, 'art', 'head.json'), 'utf8'))
  const face = new Pix(head.rows[0].length, head.rows.length).draw(head.rows, head.palette)
  const shirt = '#23262d'
  const fold = '#383d47'
  const skin = '#c98f7a'
  const lean = isLeaning ? -2 : 0
  const hand = { x: HAND.x, y: HAND.y - lift }

  // Legs and shoes.
  sprite.rect(62, 55, 6, 9, '#2b3040').rect(72, 55, 6, 9, '#2b3040')
  sprite.rect(61, 63, 8, 2, '#101216').rect(71, 63, 8, 2, '#101216')
  // The shirt, an open collar, and the arm that hangs.
  sprite.rect(60 + lean, 40, 20, 16, shirt).rect(64 + lean, 45, 1, 10, fold).rect(75 + lean, 47, 1, 8, fold)
  sprite.rect(67 + lean, 40, 6, 3, skin)
  sprite.rect(80 + lean, 42, 4, 10, shirt).rect(80 + lean, 52, 4, 3, skin)

  const headX = 52 + lean * 2
  const headY = isLeaning ? 1 : 0

  sprite.blit(face.outlined(OUTLINE), headX, headY)
  // A cigarette at the corner of the mouth, as in the photo, and its smoke.
  sprite.rect(headX + 24, headY + 33, 12, 2, '#f8fafc').rect(headX + 24, headY + 35, 12, 1, '#94a3b8')
  sprite.rect(headX + 36, headY + 33, 2, 2, '#fb923c')
  sprite.rect(headX + 38, headY + 30, 1, 2, '#cbd5e1').rect(headX + 39, headY + 27, 1, 2, '#cbd5e1').rect(headX + 38, headY + 24, 1, 2, '#e2e8f0')

  // The mallet turns on the hand that holds it, and the arm reaches to it.
  const mallet = new Pix(20, 40).draw(MALLET, MALLET_COLORS, 0, 0, 2)

  sprite.blitTurned(mallet.outlined(OUTLINE), degrees, 11, 37, hand.x, hand.y)
  for (let step = 0; step <= 6; step += 1) {
    sprite.rect(Math.round(60 + lean + ((hand.x - 60 - lean) * step) / 6) - 1, Math.round(43 + ((hand.y - 43) * step) / 6) - 1, 4, 4, shirt)
  }
  sprite.rect(hand.x - 2, hand.y - 2, 4, 4, skin)

  return sprite
}

// ---- Where everything is --------------------------------------------------------
//
// All of it is measured up from the bottom of the chat area, so the game sits
// just above the prompt box whatever the window's height. `at` is how far
// across the chat area a hole's middle is.

const S = 4
const ROWS = { back: 588, middle: 446, front: 304 }
const SPOTS = [
  { at: 0.3, top: ROWS.back },
  { at: 0.7, top: ROWS.back },
  { at: 0.14, top: ROWS.middle },
  { at: 0.5, top: ROWS.middle },
  { at: 0.86, top: ROWS.middle },
  { at: 0.3, top: ROWS.front },
  { at: 0.7, top: ROWS.front },
]
const HORIZON = 644
// How far a hidden mole rests below a risen one.
const SINK = (LIP + HAT + 6) * S
// The figure's middle is this far right of a hole's middle while it plays there,
// and its feet this far below the top of the patch.
const REACH = 91
const STAND = 27
const HOME = { at: 50, reach: 0, feet: 158 }

const num = value => String(Math.round(value * 1000) / 1000)
// A layer's left edge `offset` pixels from the point `at` (0 to 1) across, for
// an image `width` wide. A percentage alone would place it by its own width.
const across = (at, offset, width, more = '') => `calc(${num(at * 100)}% + ${num(width * at + offset)}px${more})`
// A layer's top edge `up` pixels above the bottom, for an image `height` tall.
const above = (up, height, more = '') => `calc(100% + ${num(height - up)}px${more})`
// 1 while a whack's clock is between two moments, else 0.
const between = (lane, from, to) =>
  `calc(clamp(0,(var(--w${lane}) - ${from})*999,1)*clamp(0,(${to} - var(--w${lane}))*999,1))`

function game() {
  const layers = []
  const add = (image, x, y, width, height) => layers.push({ image, x, y, size: `${num(width)}px ${num(height)}px` })
  const hidden = flag => ` + (1 - var(${flag}))*300vw`

  // What flies out: it rises and widens as the clock runs.
  SPOTS.forEach(({ at, top }, lane) => {
    const grow = `(1 + (var(--w${lane}) - .14)*1.1)`
    const width = FX_W * S
    const height = FX_H * S

    layers.push({
      image: `var(--fx${lane})`,
      x: `calc(${num(at * 100)}% + ${num(width * (at - 0.5))}px*${grow}${hidden(`--f${lane}`)})`,
      y: `calc(100% + ${num(height)}px*${grow} - ${num(top + 44)}px - (var(--w${lane}) - .14)*150px - ${num(height / 2)}px*${grow})`,
      size: `calc(${num(width)}px*${grow}) calc(${num(height)}px*${grow})`,
    })
  })
  // The flash where the mallet lands.
  SPOTS.forEach(({ at, top }, lane) => {
    add('var(--pow)', across(at, -26 - 6, 52, hidden(`--p${lane}`)), above(top + 62, 52), 52, 52)
  })
  // The figure, one layer for each way it holds the mallet.
  ;[
    ['--who0', '--up'],
    ['--who1', '--wd'],
    ['--who2', '--tp'],
    ['--who3', '--dn'],
  ].forEach(([image, flag]) => {
    add(
      `var(${image})`,
      `calc(var(--kx)*1% + var(--kx)*${num((WHO_W * 2) / 100)}px + var(--ko) - ${FEET.x * 2}px${hidden(flag)})`,
      `calc(100% + ${WHO_H * 2 - FEET.y * 2}px - var(--kb) - max(var(--kx) - var(--kq),var(--kq) - var(--kx))*3px - var(--bt)*var(--up)*2px)`,
      WHO_W * 2,
      WHO_H * 2,
    )
  })
  // The holes, nearest row first, so a mole in front rises over the patch
  // behind it. In each: the near edge of the hole, over its mole, over the patch.
  const moleY = (top, lane) =>
    above(top + (6 + HAT) * S, (16 + HAT) * S, ` + (1 - var(--u${lane}))*${SINK}px - var(--u${lane})*var(--bt)*4px + var(--z${lane})*var(--u${lane})*10px`)

  SPOTS.map((spot, lane) => ({ ...spot, lane }))
    .sort((one, other) => one.top - other.top)
    .forEach(({ at, top, lane }) => {
      add('var(--hf)', across(at, (-TILE_W * S) / 2, TILE_W * S), above(top - LIP * S, (TILE_H - LIP) * S), TILE_W * S, (TILE_H - LIP) * S)
      add('var(--dz)', across(at, -32, 64, hidden(`--z${lane}`)), moleY(top, lane), 64, (16 + HAT) * S)
      add(`var(--m${lane})`, across(at, -32, 64), moleY(top, lane), 64, (16 + HAT) * S)
      add('var(--hb)', across(at, (-TILE_W * S) / 2, TILE_W * S), above(top, TILE_H * S), TILE_W * S, TILE_H * S)
    })

  return layers
}

// ---- The meadow behind the game ----------------------------------------------------

const TREE = [
  '......gggg......',
  '....gggggggg....',
  '...gGGggggggg...',
  '..gGGggggggggg..',
  '..gGgggggggggg..',
  '.gggggggggggggD.',
  '.ggggggggggggDD.',
  '.gggggggggggDDD.',
  '..ggggggggDDDD..',
  '..gDggggDDDDDD..',
  '...DDDDDDDDDD...',
  '....DDDDDDDD....',
  '......nNnn......',
  '......nNnn......',
  '......nNnn......',
  '......nNnn......',
  '.....nnNnnn.....',
]
const MOON = [
  '....mmmmmm....',
  '..mmmmmmmmmm..',
  '.mmmMMmmmmmmm.',
  '.mmMMmmmmcmmm.',
  'mmmmmmmmmccmmm',
  'mmmmmmmmmmmmmm',
  'mmkkkmmmmkkkmm',
  'mmmmmmmmmmmmmm',
  'mmommmmmmmmomm',
  'mmmmmkmmkmmmmm',
  '.mmmmmkkmmmmm.',
  '.mmcmmmmmmmmm.',
  '..mmmmmmmmmm..',
  '....mmmmmm....',
]
const SUN = [
  '....yyyyyy....',
  '..yyyyyyyyyy..',
  '.yyyYYyyyyyyy.',
  '.yyYYyyyyyyyy.',
  'yyyyyyyyyyyyyy',
  'yyyekyyyyekyyy',
  'yyyeeyyyyeeyyy',
  'yyyyyyyyyyyyyy',
  'yyoyyyyyyyyoyy',
  'yyyykyyyykyyyy',
  '.yyyykkkkyyyy.',
  '.yyyyyyyyyyyy.',
  '..yyyyyyyyyy..',
  '....yyyyyy....',
]

// The meadow's images, by day or by night. Where they go is the same for both.
function sceneryImages(isNight) {
  const lit = markup => (isNight ? atNight(markup) : markup)
  const bits =
    paths(['g...g', '.g.g.', '.ggg.'], { g: '#2f9a4c' }, 6, 4) +
    paths(['g...g', '.g.g.', '.ggg.'], { g: '#2f9a4c' }, 78, 9) +
    paths(['.f.', 'fyf', '.f.', '.g.', '.g.'], { f: '#ffffff', y: '#ffd23f', g: '#227a41' }, 38, 2) +
    paths(['.f.', 'fyf', '.f.', '.g.', '.g.'], { f: '#ff8fa3', y: '#ffd23f', g: '#227a41' }, 112, 7) +
    paths(['.rrr.', 'rwrwr', 'rrrrr', '.www.', '.www.'], { r: '#e5484d', w: '#fff5f5' }, 58, 10)
  // Stepped hills, in a strip that meets itself where it repeats.
  const hills = (base, height, period, phase) => {
    let d = `M0 ${base}`

    for (let x = 0; x < 200; x += 4) {
      const wave = Math.sin((x / 200) * Math.PI * 2 * period + phase) * 0.6 + Math.sin((x / 200) * Math.PI * 2 * period * 3 + phase * 2) * 0.4

      d += `V${base - Math.round((((wave + 1) / 2) * height) / 2) * 2}h4`
    }

    return `${d}V${base}z`
  }
  let stars = ''
  let seed = 20261115
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff

    return seed / 0x7fffffff
  }

  for (let count = 0; count < 26; count += 1) {
    stars += `M${Math.round(random() * 146)} ${Math.round(random() * 56)}h${random() < 0.25 ? 2 : 1}v1h-1z`
  }

  // The field, mown in stripes, under a sky in bands.
  const field = lit('#7fd36a')
  const mown = lit('#8bdb74')
  const sky = isNight ? ['#243c6e', '#1a2c59', '#132045', '#0e1733', '#0a0f24'] : ['#e3f5ff', '#bfe6fc', '#93d2f9', '#6fc0f6', '#4fb0f2']
  const stops = []

  for (let y = 0; y < HORIZON; y += 86) {
    const color = (y / 86) % 2 === 0 ? field : mown

    stops.push(`${color} ${y}px`, `${color} ${Math.min(HORIZON, y + 86)}px`)
  }
  sky.forEach((color, band) => {
    stops.push(`${color} ${HORIZON + band * 64}px`, band === sky.length - 1 ? `${color} 100%` : `${color} ${HORIZON + (band + 1) * 64}px`)
  })

  return {
    '--tr': svgUrl(16, 17, 16, 17, lit(paths(TREE, { g: '#35a257', G: '#7fdc8c', D: '#227a41', n: '#8a5a3c', N: '#b98a5e' }))),
    '--gr': svgUrl(520, 60, 130, 15, lit(bits)),
    '--fe': svgUrl(44, 40, 11, 10, lit(`<path fill='#f3e3c3' d='M2 0h3v10h-3zM0 2h11v2h-11zM0 6h11v2h-11z'/><path fill='#c9a66b' d='M2 0h3v1h-3z'/>`)),
    '--hi': svgUrl(800, 120, 200, 30, lit(`<path fill='#8fd694' d='${hills(30, 26, 1, 0.4)}'/><path fill='#5fbf6b' d='${hills(30, 14, 2, 2.1)}'/>`)),
    '--orb': isNight
      ? svgUrl(14, 14, 14, 14, paths(MOON, { m: '#fdf3c4', M: '#ffffff', c: '#e3d79b', k: '#6b5a2a', o: '#f5c9a0' }))
      : svgUrl(14, 14, 14, 14, paths(SUN, { y: '#ffd23f', Y: '#fff1a8', e: '#5a3a12', k: '#5a3a12', o: '#ff9f4a' })),
    '--st': isNight ? svgUrl(600, 240, 150, 60, `<path fill='#e6eeff' d='${stars}'/>`) : 'none',
    '--sky': `linear-gradient(to top,${stops.join(',')})`,
  }
}

function scenery() {
  const layers = []
  const add = (image, position, size, repeat = 'no-repeat') => layers.push({ image, position, size, repeat })

  // Trees down both sides, larger toward the front.
  ;[
    [0.02, 230, 190],
    [0.985, 280, 210],
    [-0.01, 440, 150],
    [1.0, 480, 150],
    [0.075, 560, 110],
    [0.93, 570, 120],
  ].forEach(([at, foot, size]) => {
    const height = Math.round((size * 17) / 16)

    add('var(--tr)', `${across(at, -size / 2, size)} ${above(foot + height, height)}`, `${size}px ${height}px`)
  })
  // Tufts and flowers, in strips that repeat across.
  ;[
    [40, 60],
    [300, 190],
    [150, 340],
    [410, 470],
    [230, 580],
  ].forEach(([shift, up]) => add('var(--gr)', `${shift}px ${above(up + 60, 60)}`, '520px 60px', 'repeat-x'))
  // A fence along the horizon, and the hills behind it.
  add('var(--fe)', `0 ${above(HORIZON + 30, 40)}`, '44px 40px', 'repeat-x')
  add('var(--hi)', `0 ${above(HORIZON + 118, 120)}`, '800px 120px', 'repeat-x')
  // The moon or the sun, and the stars.
  add('var(--orb)', `${across(0.065, -42, 84)} ${above(HORIZON + 176, 84)}`, '84px 84px')
  add('var(--st)', `0 ${above(HORIZON + 300, 240)}`, '600px 240px', 'repeat-x')
  add('var(--st)', `310px ${above(HORIZON + 540, 240)}`, '600px 240px', 'repeat-x')
  add('var(--sky)', '0 0', 'auto')

  return layers
}

// ---- The style sheet ---------------------------------------------------------------

const HOST = '[data-workspace-area="conversation"]'
const LIVE = '[data-timeline-row-kind="work-live"]'

function sheet() {
  const lanes = LANES.map((_, lane) => lane)
  const css = []
  const register = (name, syntax, initial) => css.push(`@property ${name}{syntax:'${syntax}';inherits:false;initial-value:${initial}}`)

  lanes.forEach(lane => {
    register(`--u${lane}`, '<number>', 0)
    register(`--w${lane}`, '<number>', 1)
  })
  register('--kx', '<number>', HOME.at)
  register('--kq', '<number>', HOME.at)
  register('--ko', '<length>', `${HOME.reach}px`)
  register('--kb', '<length>', `${HOME.feet}px`)
  register('--ar', '<number>', 0)
  register('--bt', '<number>', 0)
  css.push('@keyframes tfbt{to{--bt:1}}')

  const night = tile({ lawn: '#3f8a66', rim: '#2b6149', shine: '#58a981' })
  const day = tile({ lawn: '#a6e488', rim: '#6dbd5b', shine: '#c9f5ae' })
  const images = [
    ...LANES.map((entry, lane) => `--m${lane}:${mole(entry).url()}`),
    ...LANES.map(({ lane }, index) => `--fx${index}:${burst(lane).url()}`),
    `--dz:${DIZZY.url()}`,
    `--pow:${POW.url()}`,
    `--who0:${whacker(-14, false).url()}`,
    `--who1:${whacker(-4, false, 10).url()}`,
    `--who2:${whacker(-44, false).url()}`,
    `--who3:${whacker(-70, true).url()}`,
  ]
  const flags = [
    ...lanes.map(lane => `--g${lane}:${between(lane, 0.02, 0.14)}`),
    ...lanes.map(lane => `--h${lane}:${between(lane, 0.14, 0.34)}`),
    ...lanes.map(lane => `--p${lane}:${between(lane, 0.14, 0.27)}`),
    ...lanes.map(lane => `--f${lane}:${between(lane, 0.14, 0.8)}`),
    ...lanes.map(lane => `--z${lane}:${between(lane, 0.14, 0.999)}`),
    `--wd:min(1,${lanes.map(lane => `var(--g${lane})`).join(' + ')})`,
    `--dn:min(1,${lanes.map(lane => `var(--h${lane})`).join(' + ')})`,
    '--tp:calc(var(--ar)*var(--bt)*(1 - var(--wd))*(1 - var(--dn)))',
    '--up:calc((1 - var(--wd))*(1 - var(--dn))*(1 - var(--tp)))',
  ]
  const layers = game()
  const moves = [
    ...lanes.map(lane => `--u${lane} var(--d${lane},.22s) var(--e${lane},ease-in) var(--l${lane},.55s)`),
    ...lanes.map(lane => `--w${lane} var(--q${lane},1.5s) linear`),
    '--kx .34s cubic-bezier(.4,0,.6,1) var(--kl,1.3s)',
    '--kq .17s linear var(--kl,1.3s)',
    '--ko .34s cubic-bezier(.4,0,.6,1) var(--kl,1.3s)',
    '--kb .34s cubic-bezier(.4,0,.6,1) var(--kl,1.3s)',
    '--ar .01s linear var(--rl,0s)',
  ]

  css.push(
    `${HOST}::before{content:"";position:absolute;inset:0;pointer-events:none;image-rendering:pixelated;background-repeat:no-repeat;` +
      `${images.join(';')};${flags.join(';')};` +
      `background-image:${layers.map(layer => layer.image).join(',')};` +
      `background-position:${layers.map(layer => `${layer.x} ${layer.y}`).join(',')};` +
      `background-size:${layers.map(layer => layer.size).join(',')};` +
      `transition:${moves.join(',')};animation:tfbt 1.1s steps(2,jump-none) infinite}`,
  )
  css.push(`${HOST}::before{--hb:${night.back.url()};--hf:${night.front.url()}}`)
  css.push(`:root:not(.dark) ${HOST}::before{--hb:${day.back.url()};--hf:${day.front.url()}}`)

  // A mole is up while its kind of tool is what the live row shows.
  LANES.forEach(({ icons, rows = [] }, lane) => {
    const { at, top } = SPOTS[lane]
    const selector = [...icons.map(icon => `${LIVE} ${icon}`), ...rows].map(inner => `${HOST}:has(${inner})::before`).join(',')

    css.push(
      `${selector}{--u${lane}:1;--w${lane}:0;--d${lane}:.26s;--e${lane}:cubic-bezier(.3,1.8,.5,1);--l${lane}:0s;--q${lane}:0s;` +
        `--kx:${num(at * 100)};--kq:${num(at * 100)};--ko:${REACH}px;--kb:${top - STAND}px;--kl:.5s;--ar:1;--rl:1s}`,
    )
  })

  // The meadow.
  const meadow = scenery()
  const vars = images => Object.entries(images).map(([name, value]) => `${name}:${value}`).join(';')

  css.push(
    `${HOST}{${vars(sceneryImages(true))};background-image:${meadow.map(layer => layer.image).join(',')};` +
      `background-position:${meadow.map(layer => layer.position).join(',')};` +
      `background-size:${meadow.map(layer => layer.size).join(',')};` +
      `background-repeat:${meadow.map(layer => layer.repeat).join(',')}}`,
  )
  css.push(`:root:not(.dark) ${HOST}{${vars(sceneryImages(false))}}`)
  // A new thread's page has no chat yet and its prompt box sits in the middle,
  // so there the meadow is empty but for the one with the mallet.
  css.push(`${HOST}>[data-timeline-loading]{background:none}`)
  css.push(
    `${HOST}:not(:has(.messages-timeline-scroll))::before{--hb:none!important;--hf:none!important;${lanes.map(lane => `--m${lane}:none`).join(';')}}`,
  )
  // Words stay readable where they cross the picture.
  css.push(`${HOST} [data-timeline-row-kind]{text-shadow:0 0 2px #0a0f24,0 0 5px #0a0f24,0 0 10px #0a0f24}`)
  css.push(`:root:not(.dark) ${HOST} [data-timeline-row-kind]{text-shadow:0 0 2px #fff,0 0 5px #fff,0 0 10px #fff}`)
  css.push(`@media (prefers-reduced-motion:reduce){${HOST}::before{transition:none;animation:none}}`)

  return css.join('\n')
}

// ---- The theme file ----------------------------------------------------------------

const css = sheet()
// The surfaces take their hue from `accent`, so it is a night-sky blue, and the
// buttons are then given the moon's yellow. T3 Code derives a whole palette
// from two colors only for the theme's own appearance, so the day's palette is
// spelled out: `art/light-colors.json` is what T3 Code derived from a sky-blue
// canvas (#e3f5ff) and a grass-green accent (#2f9a4c).
const theme = {
  version: 1,
  name: 'Tool Flow',
  appearance: 'dark',
  canvas: '#0a0f24',
  accent: '#5b8def',
  colors: { accent: '#f7d154', accentForeground: '#1a1405', focus: '#f7d154' },
  variants: { light: { ...JSON.parse(fs.readFileSync(path.join(here, 'art', 'light-colors.json'), 'utf8')), accentForeground: '#ffffff' } },
  css,
}

if (process.env.SIZES) {
  css.split('\n').forEach(rule => console.log(String(rule.length).padStart(6), rule.slice(0, 70)))
  ;[...css.matchAll(/(--[a-z0-9]+):url\("([^"]*)"\)/g)].forEach(found => console.log(String(found[2].length).padStart(6), found[1]))
}
if (css.length > 50_000) throw new Error(`The CSS is ${css.length} characters; T3 Code takes 50,000.`)
if (css.includes('\\')) throw new Error('The CSS has a backslash; T3 Code drops such a declaration.')
if (/url\((?!"data:)/.test(css)) throw new Error('The CSS has a url() that is not a quoted data: address.')
fs.writeFileSync(path.join(here, 'tool-flow.json'), JSON.stringify(theme) + '\n')
// T3 Code 0.1.9 and earlier take no CSS and ignore a theme file over 32 KB, so
// they get the colors alone, under a name of their own.
fs.writeFileSync(path.join(here, 'tool-flow-colors.json'), JSON.stringify({ ...theme, name: 'Tool Flow Colors', css: undefined }, null, 2) + '\n')
console.log(`tool-flow.json: ${css.length} characters of CSS`)
