// The agent's pen: turn a short JSON array of shapes into Excalidraw elements and push them onto the board.
// 用法: node draw.mjs examples/demo.json
//       CANVAS_URL=http://127.0.0.1:7801 node draw.mjs examples/demo.json
//
// 每一项的形状：
//   {"kind":"text","x":100,"y":100,"text":"你好","size":28,"color":"#e8e8e8"}
//   {"kind":"rect","x":100,"y":100,"w":200,"h":120,"color":"#4dabf7","fill":"#1b3a5c"}
//   {"kind":"ellipse","x":100,"y":100,"w":200,"h":120,"color":"#ffd43b"}
//   {"kind":"diamond","x":100,"y":100,"w":200,"h":120,"color":"#da77f2"}
//   {"kind":"line","points":[[0,0],[100,50]],"color":"#51cf66"}
//   {"kind":"arrow","points":[[0,0],[100,50]],"color":"#ff8787"}
import fs from 'node:fs'

const BASE = process.env.CANVAS_URL || 'http://127.0.0.1:7801'
let seed = Math.floor(Math.random() * 100000)

function base(kind, shape) {
  seed += 1
  return {
    id: `me-${Date.now().toString(36)}-${seed}`,
    type: kind,
    x: shape.x ?? 0,
    y: shape.y ?? 0,
    width: shape.w ?? 0,
    height: shape.h ?? 0,
    angle: 0,
    strokeColor: shape.color || '#e8e8e8',
    backgroundColor: shape.fill || 'transparent',
    fillStyle: 'solid',
    strokeWidth: shape.width || 2,
    strokeStyle: shape.dash ? 'dashed' : 'solid',
    roughness: shape.roughness ?? 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  }
}

const TYPE = {
  rect: 'rectangle',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  line: 'line',
  arrow: 'arrow',
  text: 'text',
}

function build(shape) {
  const type = TYPE[shape.kind] || shape.kind

  if (type === 'text') {
    const element = base(type, shape)
    element.text = String(shape.text ?? '')
    element.originalText = element.text
    element.fontSize = shape.size || 24
    element.fontFamily = shape.font ?? 2
    element.textAlign = 'left'
    element.verticalAlign = 'top'
    element.containerId = null
    element.lineHeight = 1.25
    element.autoResize = true
    // Excalidraw 不会自己折行，宽度按字数估：中文约等于字号，英文约 0.6 倍
    const widest = element.text.split('\n').reduce((max, line) => {
      let w = 0
      for (const ch of line) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? element.fontSize : element.fontSize * 0.6
      return Math.max(max, w)
    }, 0)
    element.width = Math.max(10, widest)
    element.height = element.text.split('\n').length * element.fontSize * element.lineHeight
    return element
  }

  if (type === 'line' || type === 'arrow') {
    const points = shape.points || [[0, 0], [100, 0]]
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const element = base(type, {
      ...shape,
      x: (shape.x ?? 0) + Math.min(...xs),
      y: (shape.y ?? 0) + Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    })
    element.points = points.map(([px, py]) => [px - Math.min(...xs), py - Math.min(...ys)])
    element.lastCommittedPoint = null
    element.startBinding = null
    element.endBinding = null
    element.startArrowhead = null
    element.endArrowhead = type === 'arrow' ? 'arrow' : null
    return element
  }

  const element = base(type, shape)
  if (type === 'rectangle') element.roundness = { type: 3 }
  if (type === 'ellipse') element.roundness = { type: 2 }
  if (type === 'diamond') element.roundness = { type: 2 }
  return element
}

const file = process.argv[2]
if (!file) {
  console.error('用法: node draw.mjs examples/demo.json')
  process.exit(1)
}

const shapes = JSON.parse(fs.readFileSync(file, 'utf8'))
const elements = shapes.map(build)

const target = `${BASE}/api/elements?source=me${process.env.CANVAS_QUIET === '1' ? '&broadcast=0' : ''}`
const response = await fetch(target, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ elements }),
})

console.log(await response.text())
