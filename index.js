/**
 * Host half of the vtx316-voice bundle.
 *
 * Adds the `vtx316_speak` tool: it encodes the requested text as GBK, builds a
 * 宇音天下 VTX316 speech-synthesis frame
 * (`FD | lenH | lenL | 0x01 | 0x01(GBK) | text`) and writes it to a serial
 * port through Windows PowerShell's System.IO.Ports.SerialPort, then reports
 * the module feedback (0x41 accepted, 0x45 receive failure, 0x4F playback
 * finished / idle).
 *
 * Implementation notes:
 * - No `@deepseek-ai/*` imports: a profile-installed bundle cannot resolve the
 *   dsh installation's packages, so the tool definition is a plain object in
 *   the registry's normalised JSON-Schema form.
 * - The port is opened per call and calls are serialised, so two utterances
 *   never interleave on the wire.
 * - Port and baud come from the bundle row's `config` when present.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'vtx316-voice'
/** Host services this plugin needs: the tool registry only. */
export const inject = ['tools']

const DEFAULT_PORT = 'COM6'
const DEFAULT_BAUD = 115200
const DEFAULT_WAIT_MS = 15000
const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 60000
/** VTX316 accepts at most 4000 GBK bytes per synthesis frame (manual). */
const MAX_GBK_BYTES = 3998
/** A 0x7F inside the serialised text would be fine for TTS but keep the limit simple. */

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/**
 * Normalise the bundle row config into the values a call needs.
 * @param config - raw `config` object from cordis.patch.yml, possibly absent.
 * @returns `{ port, baud, defaultVolume, defaultSpeed, defaultTone }`.
 *   A default is `undefined` when the row does not configure it, which keeps
 *   the module's own stored value.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const port =
    typeof raw.port === 'string' && /^[A-Za-z0-9.\\_-]{2,64}$/.test(raw.port.trim())
      ? raw.port.trim()
      : DEFAULT_PORT
  const baud =
    Number.isInteger(raw.baud) && raw.baud > 0 && raw.baud <= 3000000 ? raw.baud : DEFAULT_BAUD
  const intIn = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max ? value : undefined
  return {
    port,
    baud,
    defaultVolume: intIn(raw.defaultVolume, 0, 10),
    defaultSpeed: intIn(raw.defaultSpeed, 1, 30),
    defaultTone: intIn(raw.defaultTone, 0, 10),
  }
}

// ---------------------------------------------------------------------------
// serial transport (PowerShell + System.IO.Ports)
// ---------------------------------------------------------------------------

/** Absolute Windows PowerShell paths to try, in order. */
function powerShellCandidates() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return [
    `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    'powershell.exe',
    'pwsh.exe',
  ]
}

/**
 * Build the PowerShell program that opens the port, sends one VTX316 frame and
 * reads the module feedback. Every dynamic value reaches PowerShell as base64
 * or a validated number, so no quoting can break the script.
 * @param options - port, baud, UTF-8 text, leading control markers, wait flags.
 * @returns the script text for `-EncodedCommand`.
 */
function buildScript({ port, baud, text, prefix, wait, waitMs }) {
  const textB64 = Buffer.from(text, 'utf8').toString('base64')
  const prefixB64 = Buffer.from(prefix, 'utf8').toString('base64')
  const deadlineMs = wait ? waitMs : 400
  return `
$ErrorActionPreference = 'Stop'
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textB64}'))
$prefix = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${prefixB64}'))
$gbk = [Text.Encoding]::GetEncoding(936)
$payload = $gbk.GetBytes($prefix + $text)
if ($payload.Length -gt ${MAX_GBK_BYTES}) { throw ('text is too long for one VTX316 frame: ' + $payload.Length + ' GBK bytes') }
$len = $payload.Length + 2
$frame = New-Object System.Collections.Generic.List[byte]
$frame.Add(0xFD)
$frame.Add([byte](($len -shr 8) -band 0xFF))
$frame.Add([byte]($len -band 0xFF))
$frame.Add(0x01)
$frame.Add(0x01)
$frame.AddRange([byte[]]$payload)
$resp = New-Object System.Collections.Generic.List[byte]
$sp = New-Object System.IO.Ports.SerialPort('${port}', ${baud}, 'None', 8, 'One')
$sp.ReadTimeout = 150
$sp.WriteTimeout = 3000
$sw = [Diagnostics.Stopwatch]::StartNew()
$ok = $false
$err = ''
try {
  $sp.Open()
  Start-Sleep -Milliseconds 60
  $sp.DiscardInBuffer()
  $sp.Write($frame.ToArray(), 0, $frame.Count)
  $ok = $true
  $deadline = [DateTime]::Now.AddMilliseconds(${deadlineMs})
  while ([DateTime]::Now -lt $deadline) {
    try {
      $b = $sp.ReadByte()
      if ($b -ge 0) {
        $resp.Add([byte]$b)
        if ($b -eq 0x4F) { break }
      }
    } catch { }
  }
} catch {
  $err = $_.Exception.Message
} finally {
  try { if ($sp.IsOpen) { $sp.Close() } } catch { }
  $sw.Stop()
}
$hex = ($resp | ForEach-Object { $_.ToString('X2') }) -join ' '
$obj = [ordered]@{
  ok = $ok
  error = $err
  feedback = $hex
  rxCount = $resp.Count
  gbkBytes = $payload.Length
  frameBytes = $frame.Count
  elapsedMs = $sw.ElapsedMilliseconds
}
$obj | ConvertTo-Json -Compress
`
}

/**
 * Build the PowerShell program that opens the port and asks the module for its
 * current TTS parameter block: `FD 00 01 05` → `0x5F` + 17 parameter bytes.
 * @param options - port and baud of the module.
 * @returns the script text for `-EncodedCommand`.
 */
function buildParamsScript({ port, baud }) {
  return `
$ErrorActionPreference = 'Stop'
$resp = New-Object System.Collections.Generic.List[byte]
$sp = New-Object System.IO.Ports.SerialPort('${port}', ${baud}, 'None', 8, 'One')
$sp.ReadTimeout = 150
$sp.WriteTimeout = 3000
$sw = [Diagnostics.Stopwatch]::StartNew()
$ok = $false
$err = ''
try {
  $sp.Open()
  Start-Sleep -Milliseconds 60
  $sp.DiscardInBuffer()
  $sp.Write([byte[]](0xFD, 0x00, 0x01, 0x05), 0, 4)
  $ok = $true
  $deadline = [DateTime]::Now.AddMilliseconds(800)
  while ([DateTime]::Now -lt $deadline) {
    try {
      $b = $sp.ReadByte()
      if ($b -ge 0) {
        $resp.Add([byte]$b)
        if ($resp.Count -ge 18) { break }
      }
    } catch { }
  }
} catch {
  $err = $_.Exception.Message
} finally {
  try { if ($sp.IsOpen) { $sp.Close() } } catch { }
  $sw.Stop()
}
$hex = ($resp | ForEach-Object { $_.ToString('X2') }) -join ' '
$obj = [ordered]@{
  ok = $ok
  error = $err
  hex = $hex
  rxCount = $resp.Count
  elapsedMs = $sw.ElapsedMilliseconds
}
$obj | ConvertTo-Json -Compress
`
}

/** VTX316 parameter-block length after the 0x5F reply head. */
const PARAM_BLOCK_BYTES = 17
/** Text-encoding codes reported by the 0x5F reply (little-endian 16-bit). */
const TEXT_ENCODINGS = new Map([
  [0x03a9, 'GB2312'],
  [0x03a8, 'GBK'],
  [0x03aa, 'UTF8'],
  [0x04b0, 'UNICODE-LE'],
  [0x04b1, 'UNICODE-BE'],
  [0x03b6, 'BIG5'],
])

/**
 * Run one PowerShell serial transaction; returns the helper's JSON report.
 * @param script - complete PowerShell program.
 * @param timeoutMs - hard kill budget for the child process.
 * @param signal - caller cancellation.
 */
async function runPowerShell(script, timeoutMs, signal) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
  let lastError
  for (const exe of powerShellCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
      })
      const line = String(stdout)
        .split(/\r?\n/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .pop()
      if (line === undefined) throw new Error('serial helper produced no output')
      return JSON.parse(line)
    } catch (error) {
      lastError = error
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') continue
      throw error
    }
  }
  throw lastError ?? new Error('no PowerShell executable found')
}

/** Abort-aware `exclusive()` queue so utterances never interleave on the port. */
let chain = Promise.resolve()
function exclusive(task) {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Send one utterance and collect the VTX316 feedback.
 * @param settings - resolved port/baud.
 * @param request - validated call arguments.
 * @param signal - caller cancellation.
 * @returns the tool result value.
 */
function speak(settings, request, signal) {
  return exclusive(async () => {
    if (signal?.aborted) throw new Error('speech request aborted before it started')
    const { text, wait, timeoutMs } = request
    const volume = request.volume ?? settings.defaultVolume
    const speed = request.speed ?? settings.defaultSpeed
    const tone = request.tone ?? settings.defaultTone
    const prefix =
      `${volume === undefined ? '' : `[v${volume}]`}` +
      `${speed === undefined ? '' : `[s${speed}]`}` +
      `${tone === undefined ? '' : `[t${tone}]`}`
    const script = buildScript({
      port: settings.port,
      baud: settings.baud,
      text,
      prefix,
      wait,
      waitMs: timeoutMs,
    })
    const report = await runPowerShell(script, (wait ? timeoutMs : 400) + 15000, signal)
    const tokens = typeof report.feedback === 'string' && report.feedback.length > 0
      ? report.feedback.split(/\s+/)
      : []
    const accepted = tokens.includes('41')
    const finished = tokens.includes('4F')
    const failed = tokens.includes('45') || report.ok !== true
    const excerpt = text.length > 40 ? `${text.slice(0, 40)}…` : text

    let message
    if (report.ok !== true) {
      message = `打开/写入串口 ${settings.port} 失败：${report.error || '未知错误'}`
    } else if (failed) {
      message = `VTX316 返回 0x45（命令接收失败），请检查 ${settings.port} 的接线和波特率后重试。`
    } else if (finished) {
      message = `已通过 VTX316（${settings.port}）播报完成：${excerpt}`
    } else if (wait) {
      message = `已发送播报帧到 VTX316（${settings.port}），但在 ${timeoutMs}ms 内没等到 0x4F 播放完成回传（${excerpt}）。`
    } else {
      message = `已发送播报帧到 VTX316（${settings.port}）：${excerpt}`
    }

    return {
      port: settings.port,
      baud: settings.baud,
      textBytes: report.gbkBytes ?? 0,
      frameBytes: report.frameBytes ?? 0,
      appliedParams: prefix === '' ? '(module defaults)' : prefix,
      feedback: report.feedback ?? '',
      accepted,
      finished,
      failed,
      elapsedMs: report.elapsedMs ?? 0,
      message,
    }
  })
}

/**
 * Read the module's current TTS parameter block: `FD 00 01 05` → `0x5F` + 17
 * parameter bytes (encoding, speed, volume, tone, speaker, prompt-sound switch,
 * style, number/punctuation/rhythm/pinyin/surname flags, reserved, English
 * zero and English word settings).
 * @param settings - resolved port/baud.
 * @param signal - caller cancellation.
 * @returns the structured parameter values plus a human summary.
 */
function readParams(settings, signal) {
  return exclusive(async () => {
    if (signal?.aborted) throw new Error('parameter read aborted before it started')
    const script = buildParamsScript({ port: settings.port, baud: settings.baud })
    const report = await runPowerShell(script, 20000, signal)
    if (report.ok !== true) {
      throw new Error(`打开串口 ${settings.port} 失败：${report.error || '未知错误'}`)
    }
    const bytes =
      typeof report.hex === 'string' && report.hex.trim().length > 0
        ? report.hex.trim().split(/\s+/).map((part) => Number.parseInt(part, 16))
        : []
    const head = bytes.indexOf(0x5f)
    if (head < 0 || bytes.length < head + 1 + PARAM_BLOCK_BYTES) {
      throw new Error(`VTX316 未返回完整的参数块（收到：${report.hex || '无回传'}）`)
    }
    const block = bytes.slice(head + 1, head + 1 + PARAM_BLOCK_BYTES)
    const encodingCode = block[0] + block[1] * 256
    const encoding =
      TEXT_ENCODINGS.get(encodingCode) ?? `0x${encodingCode.toString(16).toUpperCase().padStart(4, '0')}`
    const value = {
      port: settings.port,
      baud: settings.baud,
      encoding,
      speed: block[2],
      volume: block[3],
      tone: block[4],
      speaker: block[5],
      promptSound: block[6],
      style: block[7],
      numberReading: block[8],
      numberOneReading: block[9],
      punctuationReading: block[10],
      rhythm: block[11],
      pinyin: block[12],
      surname: block[13],
      reserved: block[14],
      englishZero: block[15],
      englishWord: block[16],
      rawHex: bytes
        .slice(head, head + 1 + PARAM_BLOCK_BYTES)
        .map((part) => part.toString(16).toUpperCase().padStart(2, '0'))
        .join(' '),
      elapsedMs: report.elapsedMs ?? 0,
    }
    value.message =
      `VTX316 当前参数：语速 ${value.speed}、音量 ${value.volume}、语调 ${value.tone}、` +
      `发音人 ${value.speaker}、编码 ${value.encoding}、提示音开关 ${value.promptSound}、风格 ${value.style}。`
    return value
  })
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

/** Validate one call's arguments; throws on invalid input. */
function validateArgs(args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  const text = value.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('text is required and must be a non-empty string')
  }
  const volume = value.volume
  if (volume !== undefined && (!Number.isInteger(volume) || volume < 0 || volume > 10)) {
    throw new Error('volume must be an integer between 0 and 10')
  }
  const speed = value.speed
  if (speed !== undefined && (!Number.isInteger(speed) || speed < 1 || speed > 30)) {
    throw new Error('speed must be an integer between 1 and 30')
  }
  const tone = value.tone
  if (tone !== undefined && (!Number.isInteger(tone) || tone < 0 || tone > 10)) {
    throw new Error('tone must be an integer between 0 and 10')
  }
  const wait = value.wait === undefined ? true : value.wait
  if (typeof wait !== 'boolean') throw new Error('wait must be a boolean')
  const rawTimeout = value.timeoutMs === undefined ? DEFAULT_WAIT_MS : value.timeoutMs
  if (!Number.isInteger(rawTimeout) || rawTimeout < MIN_WAIT_MS || rawTimeout > MAX_WAIT_MS) {
    throw new Error(`timeoutMs must be an integer between ${MIN_WAIT_MS} and ${MAX_WAIT_MS}`)
  }
  return { text, volume, speed, tone, wait, timeoutMs: rawTimeout }
}

/** Build the tool definition in the registry's normalised JSON-Schema form. */
function createTool(settings) {
  return {
    name: 'vtx316_speak',
    description:
      'Speak text aloud through the 宇音天下 VTX316 voice module wired to this computer over serial ' +
      `(default ${settings.port} @ ${settings.baud} 8N1). The text is encoded as GBK and sent as a ` +
      'VTX316 synthesis command frame; by default the call waits until the module reports playback ' +
      'finished (0x4F) and returns the module feedback. Calls are serialized, so utterances play one ' +
      'after another instead of overwriting each other. ' +
      'Volume/speed/tone default to the module settings captured with FD 00 01 05 ' +
      `(volume ${settings.defaultVolume ?? 'as stored'}, speed ${settings.defaultSpeed ?? 'as stored'}, ` +
      `tone ${settings.defaultTone ?? 'as stored'}); pass a parameter to override one utterance. ` +
      'Important VTX316 limitation (official feature comparison marks English synthesis as not ' +
      'supported): English words are always spelled letter by letter and no control marker can switch ' +
      'that. When an English word must sound like the word, write a Chinese phonetic approximation in ' +
      'text instead (e.g. DeepSeek -> 迪普希克, hello -> 哈喽); leave uppercase model numbers and ' +
      'acronyms (STM32, VTX316, DSH) as letters on purpose, because letter reading is correct there. ' +
      'Power: when the module is powered from the USB-TTL adapter, keep volume at 5 or below — higher ' +
      'volume can brown out the serial supply and the module stops answering (no 0x4F feedback).',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to speak. Chinese, English, digits and punctuation are supported; the text is ' +
            'converted to GBK for the module.',
        },
        volume: {
          type: 'integer',
          description:
            'VTX316 volume level 0-10 applied before speaking with a [vN] control marker (the module ' +
            'stores it). Omit to use the configured default volume.',
        },
        speed: {
          type: 'integer',
          description:
            'VTX316 speech rate 1-30 (30 is fastest) applied with an [sN] control marker (the module ' +
            'stores it). Omit to use the configured default speed.',
        },
        tone: {
          type: 'integer',
          description:
            'VTX316 tone/pitch level 0-10 applied with a [tN] control marker (the module stores it). ' +
            'Omit to use the configured default tone.',
        },
        wait: {
          type: 'boolean',
          description:
            'Whether to wait until the module reports playback finished (0x4F) before returning. ' +
            'Defaults to true; false returns right after the frame is written.',
        },
        timeoutMs: {
          type: 'integer',
          description: `Maximum wait for playback finish in milliseconds, ${MIN_WAIT_MS}-${MAX_WAIT_MS}. Defaults to ${DEFAULT_WAIT_MS}.`,
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: { type: 'string', description: 'Serial port that carried the frame.' },
          baud: { type: 'integer', description: 'Serial baud rate used.' },
          textBytes: { type: 'integer', description: 'GBK bytes of text plus control markers.' },
          frameBytes: { type: 'integer', description: 'Total bytes written for the VTX316 frame.' },
          appliedParams: { type: 'string', description: 'Control markers applied to this utterance (e.g. [v1][s23][t9]).' },
          feedback: { type: 'string', description: 'Module feedback bytes as space-separated hex.' },
          accepted: { type: 'boolean', description: 'Module reported 0x41 (command received).' },
          finished: { type: 'boolean', description: 'Module reported 0x4F (playback finished).' },
          failed: { type: 'boolean', description: 'Module reported 0x45 or the frame could not be sent.' },
          elapsedMs: { type: 'integer', description: 'Serial transaction time in milliseconds.' },
          message: { type: 'string', description: 'Short human summary of the outcome.' },
        },
        required: ['port', 'baud', 'textBytes', 'frameBytes', 'appliedParams', 'feedback', 'accepted', 'finished', 'failed', 'elapsedMs', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'VTX316 语音播报',
        kind: 'execute',
        rawInput: { text: args.text },
      }
    },
    presentResult(_args, result) {
      return {
        card: 'generic',
        title: result.isError ? 'VTX316 播报失败' : 'VTX316 语音播报',
        content: result.content,
      }
    },
    async execute(args, exec) {
      const request = validateArgs(args)
      return speak(settings, request, exec.signal)
    },
  }
}

/** Build the parameter-read tool definition in the registry's normalised JSON-Schema form. */
function createParamsTool(settings) {
  const intField = (description) => ({ type: 'integer', description })
  return {
    name: 'vtx316_get_params',
    description:
      'Read the current TTS parameter block from the 宇音天下 VTX316 voice module on ' +
      `${settings.port} @ ${settings.baud} 8N1 with command FD 00 01 05 (reply 0x5F + 17 bytes: ` +
      'text encoding, speed, volume, tone, speaker, prompt-sound switch, pronunciation style, ' +
      'number/punctuation/rhythm/pinyin/surname flags, reserved, English zero and English word ' +
      'settings). Use it to see which values the module stores before overriding volume/speed/tone ' +
      'in vtx316_speak.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: { type: 'string', description: 'Serial port queried.' },
          baud: { type: 'integer', description: 'Serial baud rate used.' },
          encoding: { type: 'string', description: 'Text encoding reported by the module (GBK, GB2312, UTF8, ...).' },
          speed: intField('Speech rate [s*], 1-30.'),
          volume: intField('Volume [v*], 0-10.'),
          tone: intField('Tone [t*], 0-10.'),
          speaker: intField('Speaker id [m*].'),
          promptSound: intField('Prompt-sound switch [x*].'),
          style: intField('Pronunciation style [f*].'),
          numberReading: intField('Number reading [n*].'),
          numberOneReading: intField('Digit-one reading [y*].'),
          punctuationReading: intField('Punctuation reading [b*].'),
          rhythm: intField('Rhythm [z*].'),
          pinyin: intField('Pinyin recognition [i*].'),
          surname: intField('Surname reading [r*].'),
          reserved: intField('Reserved byte.'),
          englishZero: intField('English zero reading [o*].'),
          englishWord: intField('English word reading [h*].'),
          rawHex: { type: 'string', description: 'Raw 0x5F reply as space-separated hex.' },
          elapsedMs: intField('Serial transaction time in milliseconds.'),
          message: { type: 'string', description: 'Short human summary of the parameter block.' },
        },
        required: ['port', 'baud', 'encoding', 'speed', 'volume', 'tone', 'speaker', 'promptSound', 'style', 'numberReading', 'numberOneReading', 'punctuationReading', 'rhythm', 'pinyin', 'surname', 'reserved', 'englishZero', 'englishWord', 'rawHex', 'elapsedMs', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    presentCall() {
      return { card: 'generic', title: 'VTX316 参数读取', kind: 'execute' }
    },
    presentResult(_args, result) {
      return {
        card: 'generic',
        title: result.isError ? 'VTX316 参数读取失败' : 'VTX316 参数读取',
        content: result.content,
      }
    },
    async execute(_args, exec) {
      return readParams(settings, exec.signal)
    },
  }
}

/**
 * Register the VTX316 tools for this composition.
 * @param ctx - Cordis context providing the tool registry.
 * @param config - bundle row config (`port`, `baud`, speech defaults).
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  ctx.effect(() => ctx.tools.register(createTool(settings)), 'vtx316_speak tool')
  ctx.effect(() => ctx.tools.register(createParamsTool(settings)), 'vtx316_get_params tool')
}
