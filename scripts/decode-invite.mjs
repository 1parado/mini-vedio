// 解码邀请码文本，打印其中的 SDP（排查精简器用）
// 用法: node scripts/decode-invite.mjs <invite文件路径>
import fs from 'node:fs'
import zlib from 'node:zlib'

const code = fs.readFileSync(process.argv[2], 'utf8').trim()
const body = code.startsWith('MV1-') ? code.slice(4) : code
const bin = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const json = JSON.parse(zlib.inflateSync(bin).toString('utf8'))
console.log('kind:', json.t, ' sdpLen:', json.s.length)
console.log(json.s)
