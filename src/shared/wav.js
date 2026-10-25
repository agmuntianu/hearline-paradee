// 16-bit PCM WAV writer — shared by both HQ engines and the offscreen document.
// Kept out of the engine files so importing it does not drag ONNX Runtime along.

export function wavBlob(chunks, sr) {
  let n = 0
  for (const c of chunks) n += c.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  let o = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const x = Math.max(-1, Math.min(1, c[i]))
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}
