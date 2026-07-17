// import Contactable, { core } from 'oicq'
import querystring from 'querystring'
import fetch, { File, fileFromSync, FormData } from 'node-fetch'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import child_process from 'child_process'
import { Config } from './config.js'
import path from 'path'
import { mkdirs, getUin } from './common.js'
import { withCloudTranscodeTimeout } from '../dist/runtime/cloud-transcode.js'
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_CLOUD_JSON_BYTES = 64 * 1024

function combinedSignal (first, second) {
  if (!first) return second
  if (!second) return first
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second])
  const controller = new AbortController()
  const abort = source => controller.abort(source.reason)
  if (first.aborted) abort(first)
  else if (second.aborted) abort(second)
  else {
    first.addEventListener('abort', () => abort(first), { once: true })
    second.addEventListener('abort', () => abort(second), { once: true })
  }
  return controller.signal
}

async function raceWithSignal (operation, signal) {
  if (signal === undefined) return await operation
  if (signal.aborted) throw signal.reason
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    )
  })
}

async function readBoundedBytes (response, maximumBytes) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const normalized = String(contentLength).trim()
    if (!/^(?:0|[1-9][0-9]*)$/.test(normalized) || Number(normalized) > maximumBytes) {
      throw new Error('audio response is too large')
    }
  }
  if (response.body?.[Symbol.asyncIterator] === undefined) {
    throw new Error('audio response body is unavailable')
  }
  const chunks = []
  let byteLength = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > maximumBytes) {
      response.body.destroy?.()
      throw new Error('audio response is too large')
    }
    chunks.push(bytes)
  }
  if (byteLength === 0) throw new Error('audio response is empty')
  return Buffer.concat(chunks, byteLength)
}

function boundedBase64Buffer (value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4) {
    throw new Error('audio base64 payload is too large')
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('audio base64 payload is invalid')
  }
  return buffer
}

async function assertBoundedAudioFile (file) {
  const stat = await fs.promises.stat(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUDIO_BYTES) {
    throw new Error('audio file size is invalid')
  }
}

function boundedAudioBuffer (value) {
  let buffer
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    buffer = Buffer.from(value)
  } else if (Array.isArray(value)) {
    buffer = Buffer.from(value)
  } else {
    throw new Error('audio buffer is invalid')
  }
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('audio buffer size is invalid')
  }
  return buffer
}

async function unlinkQuietly (file) {
  if (!file) return
  await fs.promises.unlink(file).catch(() => undefined)
}
let module
try {
  module = await import('oicq')
} catch (err) {
  try {
    module = await import('icqq')
  } catch (err1) {
    // 可能是go-cqhttp之类的
  }
}
let pcm2slk, core, Contactable
if (module) {
  core = module.core
  Contactable = module.default
  try {
    pcm2slk = (await import('node-silk')).pcm2slk
  } catch (e) {
    if (Config.cloudTranscode) {
      logger.warn('未安装node-silk，将尝试使用云转码服务进行合成')
    } else {
      Config.debug && logger.error('groupmate.tts.silk_module_unavailable')
      logger.warn('未安装node-silk，如ffmpeg不支持amr编码请安装node-silk以支持语音模式')
    }
  }
}

// import { pcm2slk } from 'node-silk'
let errors = {}

async function uploadRecord (recordUrl, ttsMode = 'vits-uma-genshin-honkai', ignoreEncode = false, signal) {
  if (signal?.aborted === true) throw signal.reason
  let recordType = 'url'
  let tmpFile = ''
  if (ttsMode === 'azure') {
    recordType = 'file'
  } else if (ttsMode === 'voicevox') {
    recordType = 'buffer'
    tmpFile = `data/chatgpt/tts/tmp/${crypto.randomUUID()}.wav`
  }
  try {
    if (ignoreEncode) {
      if (recordUrl instanceof Uint8Array) boundedAudioBuffer(recordUrl)
      if (typeof recordUrl === 'string' && recordUrl.startsWith('base64://')) {
        boundedBase64Buffer(recordUrl.slice('base64://'.length))
      } else if (typeof recordUrl === 'string' && !/^https?:\/\//i.test(recordUrl)) {
        await assertBoundedAudioFile(recordUrl.replace(/^file:\/{2}/, ''))
      }
      return segment.record(recordUrl)
    }
    let result
    if (pcm2slk) {
      result = await getPttBuffer(recordUrl, Bot.config.ffmpeg_path, signal)
    } else if (Config.cloudTranscode) {
      logger.mark('groupmate.tts.cloud_transcode_started')
      if (recordType === 'buffer') {
        const input = boundedAudioBuffer(recordUrl)
        mkdirs('data/chatgpt/tts/tmp')
        await fs.promises.writeFile(tmpFile, input)
        recordType = 'file'
        recordUrl = tmpFile
      }
      if (recordType === 'file' || Config.cloudMode === 'file') {
        if (typeof recordUrl !== 'string' || recordUrl === '') return false
        const formData = new FormData()
        if (!/^https?:\/\//i.test(recordUrl)) {
          await assertBoundedAudioFile(recordUrl)
          formData.append('file', fileFromSync(recordUrl))
        } else {
          const response = await fetch(recordUrl, {
            method: 'GET',
            signal,
            headers: {
              'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 9 Build/SKQ1.211230.001)'
            }
          })
          if (!response.ok) throw new Error('audio download was rejected')
          const buffer = await readBoundedBytes(response, MAX_AUDIO_BYTES)
          formData.append('file', new File([buffer], 'audio.wav'))
        }
        const cloudUrl = new URL(Config.cloudTranscode)
        const resultres = await withCloudTranscodeTimeout(timeoutSignal => fetch(`${cloudUrl}audio`, {
          method: 'POST',
          body: formData,
          signal: combinedSignal(signal, timeoutSignal)
        }))
        if (!resultres.ok) throw new Error('cloud transcoding was rejected')
        result = { buffer: await readBoundedBytes(resultres, MAX_AUDIO_BYTES) }
      } else {
        const cloudUrl = new URL(Config.cloudTranscode)
        const resultres = await withCloudTranscodeTimeout(timeoutSignal => fetch(`${cloudUrl}audio`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ recordUrl }),
          signal: combinedSignal(signal, timeoutSignal)
        }))
        if (!resultres.ok) throw new Error('cloud transcoding was rejected')
        const payload = await readBoundedBytes(resultres, MAX_CLOUD_JSON_BYTES)
        result = JSON.parse(payload.toString('utf8'))
      }
      if (result?.error !== undefined) return false
      result = {
        buffer: boundedAudioBuffer(result?.buffer?.data ?? result?.buffer)
      }
    } else {
      return false
    }
    if (!result?.buffer) return false
    const buf = boundedAudioBuffer(result.buffer)
    if (signal?.aborted === true) throw signal.reason
    const hash = md5(buf)
    const codec = String(buf.slice(0, 7)).includes('SILK') ? 1 : 0
    const body = core.pb.encode({
      1: 3,
      2: 3,
      5: {
        1: Contactable.target,
        2: getUin(),
        3: 0,
        4: hash,
        5: buf.length,
        6: hash,
        7: 5,
        8: 9,
        9: 4,
        11: 0,
        10: Bot.apk.version,
        12: 1,
        13: 1,
        14: 0,
        15: 1
      }
    })
    const payload = await raceWithSignal(Bot.sendUni('PttStore.GroupPttUp', body), signal)
    const rsp = core.pb.decode(payload)[5]
    rsp[2] && (0, errors.drop)(rsp[2], rsp[3])
    const ip = rsp[5]?.[0] || rsp[5]; const port = rsp[6]?.[0] || rsp[6]
    const ukey = rsp[7].toHex(); const filekey = rsp[11].toHex()
    const params = {
      ver: 4679,
      ukey,
      filekey,
      filesize: buf.length,
      bmd5: hash.toString('hex'),
      mType: 'pttDu',
      voice_encodec: codec
    }
    const url = `http://${int32ip2str(ip)}:${port}/?` + querystring.stringify(params)
    const headers = {
      'User-Agent': `QQ/${Bot.apk.version} CFNetwork/1126`,
      'Net-Type': 'Wifi'
    }
    const upload = await fetch(url, {
      method: 'POST',
      headers,
      body: buf,
      signal
    })
    if (!upload.ok) throw new Error('voice upload was rejected')

    const fid = rsp[11].toBuffer()
    const b = core.pb.encode({
      1: 4,
      2: getUin(),
      3: fid,
      4: hash,
      5: hash.toString('hex') + '.amr',
      6: buf.length,
      11: 1,
      18: fid,
      30: Buffer.from([8, 0, 40, 0, 56, 0])
    })
    return {
      type: 'record', file: 'protobuf://' + Buffer.from(b).toString('base64')
    }
  } catch {
    if (signal?.aborted === true) throw signal.reason
    logger.error('groupmate.tts.audio_upload_failed')
    return false
  } finally {
    await unlinkQuietly(tmpFile)
  }
}

export default uploadRecord

async function getPttBuffer (file, ffmpeg = 'ffmpeg', signal) {
  if (signal?.aborted === true) throw signal.reason
  let buffer
  let time
  if (file instanceof Uint8Array || (typeof file === 'string' && file.startsWith('base64://'))) {
    // Buffer或base64
    const buf = file instanceof Uint8Array
      ? boundedAudioBuffer(file)
      : boundedBase64Buffer(file.slice(9))
    const head = buf.slice(0, 7).toString()
    if (head.includes('SILK') || head.includes('AMR')) {
      return { buffer: buf, time }
    } else {
      buffer = await transcodeBuffer(buf, ffmpeg, signal)
    }
  } else if (typeof file === 'string' && (file.startsWith('http://') || file.startsWith('https://'))) {
    const headers = {
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 9 Build/SKQ1.211230.001)'
    }
    const response = await fetch(file, { method: 'GET', headers, signal })
    if (!response.ok) throw new Error('audio download was rejected')
    const buf = await readBoundedBytes(response, MAX_AUDIO_BYTES)
    const head = buf.slice(0, 7).toString()
    buffer = head.includes('SILK') || head.includes('AMR')
      ? buf
      : await transcodeBuffer(buf, ffmpeg, signal)
  } else {
    // 本地文件
    file = String(file).replace(/^file:\/{2}/, '')
    IS_WIN && file.startsWith('/') && (file = file.slice(1))
    await assertBoundedAudioFile(file)
    const head = await read7Bytes(file)
    if (head.includes('SILK') || head.includes('AMR')) {
      buffer = await fs.promises.readFile(file)
    } else {
      buffer = await audioTrans(file, ffmpeg, signal)
    }
  }
  return { buffer: boundedAudioBuffer(buffer), time }
}

async function transcodeBuffer (buffer, ffmpeg, signal) {
  const tmpfile = path.join(TMP_DIR, uuid())
  try {
    await fs.promises.writeFile(tmpfile, boundedAudioBuffer(buffer))
    return await audioTrans(tmpfile, ffmpeg, signal)
  } finally {
    await unlinkQuietly(tmpfile)
  }
}

async function audioTrans (file, ffmpeg = 'ffmpeg', signal) {
  if (signal?.aborted === true) throw signal.reason
  const tmpfile = path.join(TMP_DIR, uuid())
  return new Promise((resolve, reject) => {
    child_process.execFile(ffmpeg, [
      '-i', file, '-f', 's16le', '-ac', '1', '-ar', '24000', tmpfile
    ], {
      windowsHide: true,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      signal
    }, async error => {
      try {
        if (error) throw error
        await assertBoundedAudioFile(tmpfile)
        const encoded = pcm2slk(await fs.promises.readFile(tmpfile))
        resolve(boundedAudioBuffer(encoded))
      } catch {
        reject(new core.ApiRejection(ErrorCode.FFmpegPttTransError, '音频转码到pcm失败，请确认你的ffmpeg可以处理此转换'))
      } finally {
        await unlinkQuietly(tmpfile)
      }
    })
  })
}

async function read7Bytes (file) {
  const fd = await fs.promises.open(file, 'r')
  try {
    return (await fd.read(Buffer.alloc(7), 0, 7, 0)).buffer
  } finally {
    await fd.close()
  }
}

function uuid () {
  let hex = crypto.randomBytes(16).toString('hex')
  return hex.substr(0, 8) + '-' + hex.substr(8, 4) + '-' + hex.substr(12, 4) + '-' + hex.substr(16, 4) + '-' + hex.substr(20)
}
function int32ip2str (ip) {
  if (typeof ip === 'string') { return ip }
  ip = ip & 0xffffffff
  return [
    ip & 0xff,
    (ip & 0xff00) >> 8,
    (ip & 0xff0000) >> 16,
    (ip & 0xff000000) >> 24 & 0xff
  ].join('.')
}
const IS_WIN = os.platform() === 'win32'
/** 系统临时目录，用于临时存放下载的图片等内容 */
const TMP_DIR = os.tmpdir()
/** md5 hash */
const md5 = (data) => (0, crypto.createHash)('md5').update(data).digest()

errors.LoginErrorCode = errors.drop = errors.ErrorCode = void 0
let ErrorCode;
(function (ErrorCode) {
  /** 客户端离线 */
  ErrorCode[ErrorCode.ClientNotOnline = -1] = 'ClientNotOnline'
  /** 发包超时未收到服务器回应 */
  ErrorCode[ErrorCode.PacketTimeout = -2] = 'PacketTimeout'
  /** 用户不存在 */
  ErrorCode[ErrorCode.UserNotExists = -10] = 'UserNotExists'
  /** 群不存在(未加入) */
  ErrorCode[ErrorCode.GroupNotJoined = -20] = 'GroupNotJoined'
  /** 群员不存在 */
  ErrorCode[ErrorCode.MemberNotExists = -30] = 'MemberNotExists'
  /** 发消息时传入的参数不正确 */
  ErrorCode[ErrorCode.MessageBuilderError = -60] = 'MessageBuilderError'
  /** 群消息被风控发送失败 */
  ErrorCode[ErrorCode.RiskMessageError = -70] = 'RiskMessageError'
  /** 群消息有敏感词发送失败 */
  ErrorCode[ErrorCode.SensitiveWordsError = -80] = 'SensitiveWordsError'
  /** 上传图片/文件/视频等数据超时 */
  ErrorCode[ErrorCode.HighwayTimeout = -110] = 'HighwayTimeout'
  /** 上传图片/文件/视频等数据遇到网络错误 */
  ErrorCode[ErrorCode.HighwayNetworkError = -120] = 'HighwayNetworkError'
  /** 没有上传通道 */
  ErrorCode[ErrorCode.NoUploadChannel = -130] = 'NoUploadChannel'
  /** 不支持的file类型(没有流) */
  ErrorCode[ErrorCode.HighwayFileTypeError = -140] = 'HighwayFileTypeError'
  /** 文件安全校验未通过不存在 */
  ErrorCode[ErrorCode.UnsafeFile = -150] = 'UnsafeFile'
  /** 离线(私聊)文件不存在 */
  ErrorCode[ErrorCode.OfflineFileNotExists = -160] = 'OfflineFileNotExists'
  /** 群文件不存在(无法转发) */
  ErrorCode[ErrorCode.GroupFileNotExists = -170] = 'GroupFileNotExists'
  /** 获取视频中的图片失败 */
  ErrorCode[ErrorCode.FFmpegVideoThumbError = -210] = 'FFmpegVideoThumbError'
  /** 音频转换失败 */
  ErrorCode[ErrorCode.FFmpegPttTransError = -220] = 'FFmpegPttTransError'
})(ErrorCode = errors.ErrorCode || (errors.ErrorCode = {}))
const ErrorMessage = {
  [ErrorCode.UserNotExists]: '查无此人',
  [ErrorCode.GroupNotJoined]: '未加入的群',
  [ErrorCode.MemberNotExists]: '幽灵群员',
  [ErrorCode.RiskMessageError]: '群消息发送失败，可能被风控',
  [ErrorCode.SensitiveWordsError]: '群消息发送失败，请检查消息内容',
  10: '消息过长',
  34: '消息过长',
  120: '在该群被禁言',
  121: 'AT全体剩余次数不足'
}
function drop (code, message) {
  if (!message || !message.length) { message = ErrorMessage[code] }
  throw new core.ApiRejection(code, message)
}
errors.drop = drop
/** 登录时可能出现的错误，不在列的都属于未知错误，暂时无法解决 */
let LoginErrorCode;
(function (LoginErrorCode) {
  /** 密码错误 */
  LoginErrorCode[LoginErrorCode.WrongPassword = 1] = 'WrongPassword'
  /** 账号被冻结 */
  LoginErrorCode[LoginErrorCode.AccountFrozen = 40] = 'AccountFrozen'
  /** 发短信太频繁 */
  LoginErrorCode[LoginErrorCode.TooManySms = 162] = 'TooManySms'
  /** 短信验证码错误 */
  LoginErrorCode[LoginErrorCode.WrongSmsCode = 163] = 'WrongSmsCode'
  /** 滑块ticket错误 */
  LoginErrorCode[LoginErrorCode.WrongTicket = 237] = 'WrongTicket'
})(LoginErrorCode = errors.LoginErrorCode || (errors.LoginErrorCode = {}))
