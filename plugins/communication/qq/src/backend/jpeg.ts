/** Finds the end of a structurally complete JPEG codestream, leaving any outer trailer untouched.
 * Marker lengths keep APP/COM payloads opaque; entropy scans use JPEG byte stuffing/restart rules.
 * This validates framing, not entropy coefficients or the quality of decoded pixels.
 */
export function jpegImageEnd(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const word = (offset: number) => bytes[offset]! * 256 + bytes[offset + 1]!
  let offset = 2, scanning = false, scanHasData = false, scans = 0, heightKnown = false
  let restartInterval = 0, nextRestart = 0
  let components: Set<number> | null = null
  while (offset < bytes.length) {
    const fromScan = scanning
    if (scanning) while (offset < bytes.length && bytes[offset] !== 0xff) { scanHasData = true; offset++ }
    if (bytes[offset++] !== 0xff) return null
    while (bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]!
    if (fromScan && (marker === 0 || marker === 1 || marker >= 0xd0 && marker <= 0xd7)) {
      if (marker === 0) scanHasData = true
      if (marker >= 0xd0 && marker <= 0xd7) {
        if (!restartInterval || !scanHasData || marker !== 0xd0 + nextRestart) return null
        nextRestart = (nextRestart + 1) % 8; scanHasData = false
      }
      continue
    }
    if (fromScan && !scanHasData) return null
    scanning = false
    if (marker === 0xd9) return components && heightKnown && scans > 0 ? offset : null
    if (marker === 1) continue
    if (marker < 0xc0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) return null
    const length = word(offset)
    if (length < 2 || offset + length > bytes.length) return null
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (frame) {
      if (length < 11 || bytes[offset + 2]! < 1 || bytes[offset + 2]! > 16 || word(offset + 5) === 0) return null
      const count = bytes[offset + 7]!
      if (count === 0 || length !== 8 + 3 * count) return null
      components = new Set()
      for (let index = 0; index < count; index++) {
        const start = offset + 8 + 3 * index, id = bytes[start]!, sampling = bytes[start + 1]!
        if (components.has(id) || (sampling >> 4) === 0 || (sampling >> 4) > 4 || (sampling & 15) === 0 || (sampling & 15) > 4) return null
        components.add(id)
      }
      heightKnown = word(offset + 3) > 0
    } else if (marker === 0xda) {
      if (!components || length < 8) return null
      const count = bytes[offset + 2]!, selected = new Set<number>()
      if (count < 1 || count > 4 || length !== 6 + 2 * count) return null
      for (let index = 0; index < count; index++) {
        const id = bytes[offset + 3 + 2 * index]!
        if (!components.has(id) || selected.has(id)) return null
        selected.add(id)
      }
      scans++; scanning = true; scanHasData = false; nextRestart = 0
    } else if (marker === 0xdc) {
      if (!fromScan || scans !== 1 || length !== 4 || word(offset + 2) === 0) return null
      heightKnown = true
    } else if (marker === 0xdd) {
      if (length !== 4) return null
      restartInterval = word(offset + 2)
    }
    offset += length
  }
  return null
}
