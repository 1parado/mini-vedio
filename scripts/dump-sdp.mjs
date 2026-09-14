// 解码邀请码并把 SDP 写到旁边 .sdp 文件（排查用）
// 用法: node scripts/dump-sdp.mjs <invite文件路径>
import fs from 'node:fs'
import zlib from 'node:zlib'

const raw = fs.readFileSync(process.argv[2], 'utf8')
const line = raw.split(/\r?\n/).find((l) => l.includes('MV1-'))
if (!line) {
  console.error('输入文件里没有 MV1- 邀请码行')
  process.exit(1)
}
const code = line.trim().replace(/"/g, '')
const bin = Buffer.from(code.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const json = JSON.parse(zlib.inflateSync(bin).toString('utf8'))
fs.writeFileSync(process.argv[2].replace(/\.txt$/, '.sdp'), json.s)
console.log('kind=' + json.t, 'sdpLen=' + json.s.length, '->', process.argv[2].replace(/\.txt$/, '.sdp'))
