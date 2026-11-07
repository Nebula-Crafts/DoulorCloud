/**
 * 极简 SMTP 客户端（跑在 Cloudflare Workers 上，基于 `cloudflare:sockets` 的
 * 出站 TCP 能力）。
 *
 * 背景：Workers 长期被认为「发不了 SMTP」—— 早期确实没有 TCP；但
 * `cloudflare:sockets` 上线后这条路就通了（465 隐式 TLS / 587 STARTTLS 都支持）。
 * 之前项目里接的是「Posta 自建网关」（HTTP → 网关背后的 QQ SMTP），2026-11-07
 * 站长要求直接改成**基础 SMTP 配置**，方便接入任意邮箱（QQ / 163 / Gmail /
 * 企业邮箱）而不用先架一层网关 —— 就是这个模块。
 *
 * 实现范围（刻意保持最小）：
 *   * EHLO → （需要时 STARTTLS 升级）→ AUTH PLAIN / LOGIN → MAIL → RCPT → DATA → QUIT；
 *   * 465 端口走隐式 TLS（连接即 TLS），其余端口先明文 EHLO、再按服务器 advertised
 *     的 STARTTLS 升级 —— QQ/163/企业邮箱的 587 都是这个流程；
 *   * 正文用 `multipart/alternative`（纯文本 + HTML 双份，renderMail 的卡片样式生效），
 *     base64 传输编码；主题与发件人名用 RFC 2047 encoded-word；
 *   * 不支持：附件、ESMTP DSN、PIPELINING（逐条命令等回包，慢一点但稳）。
 *
 * 为什么不引库：npm 上的 SMTP 客户端（nodemailer 等）依赖 Node 运行时，在 Workers
 * 里跑不起来；而按上面的范围手写只有 ~200 行，还少一个依赖。
 */
import { connect } from "cloudflare:sockets"

/** SMTP 账户（后台「邮件发送通道」里配的那一套） */
export interface SmtpAccount {
  host: string
  port: number
  username: string
  password: string
  /** 信封 MAIL FROM 与 From 头的地址。空 = 用 username（QQ/163 要求两者一致） */
  fromEmail: string
  /** From 头显示名（可空） */
  fromName: string
}

export interface SmtpMessage {
  to: string
  subject: string
  text: string
  html?: string
}

/** 协议级失败（连接被拒 / 5xx 回包等），调用方转成业务错误 */
export class SmtpSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SmtpSendError"
  }
}

const READ_TIMEOUT_MS = 15_000

/** UTF-8 → base64（btoa 只吃 latin1，中文必须先过 TextEncoder） */
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** RFC 2047 encoded-word：中英文混排的主题/发件人名都能安全进信头 */
function encodedWord(s: string): string {
  return `=?UTF-8?B?${b64utf8(s)}?=`
}

/** base64 按 76 字符折行（RFC 2045 对 CTE 行长的要求） */
function foldB64(s: string): string {
  const out: string[] = []
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76))
  return out.join("\r\n")
}

/** 一次会话的读写句柄；STARTTLS 后整体替换 */
class SmtpConn {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private buf = ""
  private decoder = new TextDecoder()

  constructor(private socket: Socket) {
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmtpSendError(`${what} 超时（${READ_TIMEOUT_MS / 1000}s）`))
      }, READ_TIMEOUT_MS)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          reject(err instanceof SmtpSendError ? err : new SmtpSendError(`${what}: ${String(err)}`))
        }
      )
    })
  }

  /** 读一条完整回包：多行回复以「250-…」续、直到「250␣…」结束 */
  async readReply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const idx = this.buf.indexOf("\r\n")
      if (idx >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        if (!/^\d{3}[- ]/.test(line)) {
          throw new SmtpSendError(`SMTP 回复格式异常：${JSON.stringify(line.slice(0, 80))}`)
        }
        const code = Number(line.slice(0, 3))
        const cont = line[3] === "-"
        if (!cont) return { code, text: line.slice(4) }
        // 续行：继续读到终止行；已读到的中间行暂不保留（能力解析在 EHLO 单独做）
        continue
      }
      const { value, done } = await this.withTimeout(this.reader.read(), "等待服务器回包")
      if (done) throw new SmtpSendError("连接被服务器关闭")
      this.buf += this.decoder.decode(value, { stream: true })
    }
  }

  async cmd(line: string, expect: number[]): Promise<{ code: number; text: string }> {
    await this.withTimeout(
      this.writer.write(new TextEncoder().encode(`${line}\r\n`)),
      "发送命令"
    )
    const reply = await this.readReply()
    if (!expect.includes(reply.code)) {
      throw new SmtpSendError(`服务器拒绝 ${line.split(" ")[0]}：${reply.code} ${reply.text.slice(0, 120)}`)
    }
    return reply
  }

  /**
   * EHLO 并解析能力（AUTH 机制 / STARTTLS）。
   * 多行回包的中间行不经过 readReply 的返回值，所以能力解析在这里单独读。
   */
  async ehlo(): Promise<{ auth: string[]; starttls: boolean }> {
    await this.withTimeout(
      this.writer.write(new TextEncoder().encode("EHLO xceedcloud\r\n")),
      "发送 EHLO"
    )
    let auth: string[] = []
    let starttls = false
    for (;;) {
      const { value, done } = await this.withTimeout(this.reader.read(), "等待 EHLO 回包")
      if (done) throw new SmtpSendError("EHLO 时连接被关闭")
      this.buf += this.decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        if (!/^\d{3}[- ]/.test(line)) throw new SmtpSendError(`EHLO 回复异常：${JSON.stringify(line.slice(0, 80))}`)
        const code = Number(line.slice(0, 3))
        const payload = line.slice(4).toUpperCase()
        if (payload.startsWith("AUTH")) auth = payload.split(/\s+/).slice(1).filter(Boolean)
        if (payload === "STARTTLS") starttls = true
        if (line[3] === " ") {
          if (code !== 250) throw new SmtpSendError(`EHLO 失败：${code} ${payload.slice(0, 120)}`)
          return { auth, starttls }
        }
      }
    }
  }

  async startTls(): Promise<void> {
    await this.cmd("STARTTLS", [220])
    // startTls() 返回升级后的 Socket（同步），真正耗时的是底层 TLS 握手；
    // 包一层 async 让超时竞速仍然覆盖它。
    await this.withTimeout((async () => this.socket.startTls())(), "TLS 握手")
    // 升级后旧的读写器作废，必须重新拿
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
    this.buf = ""
  }

  async close(): Promise<void> {
    try {
      await this.writer.write(new TextEncoder().encode("QUIT\r\n"))
    } catch {
      /* 服务器先关就发不出去，无所谓 */
    }
    try {
      await this.socket.close()
    } catch {
      /* 已关闭时 close 会抛，忽略 */
    }
  }
}

/** 一封信的 MIME 内容（纯文本 + HTML 双份，base64 CTE） */
export function buildMessage(account: SmtpAccount, msg: SmtpMessage): string {
  const from = account.fromName
    ? `${encodedWord(account.fromName)} <${account.fromEmail}>`
    : account.fromEmail
  const domain = account.fromEmail.split("@")[1] ?? "localhost"
  const boundary = `=_xceed_${crypto.randomUUID().replaceAll("-", "")}`
  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${encodedWord(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const part = (ctype: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${ctype}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      foldB64(b64utf8(body)),
      "",
    ].join("\r\n")

  const body = [
    `This is a multi-part message in MIME format.`,
    part("text/plain", msg.text),
    ...(msg.html ? [part("text/html", msg.html)] : []),
    `--${boundary}--`,
    "",
  ].join("\r\n")

  // 点透明（dot-stuffing）：DATA 阶段行首的 . 要翻倍，防提前终结
  const stuffed = body
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n")

  return `${headers.join("\r\n")}\r\n\r\n${stuffed}`
}

/** 发一封信。协议失败抛 SmtpSendError，由 mailer 转成业务错误 */
export async function smtpSend(account: SmtpAccount, msg: SmtpMessage): Promise<void> {
  const tlsFirst = account.port === 465
  const socket = connect(`${account.host}:${account.port}`, {
    secureTransport: tlsFirst ? "on" : "starttls",
    allowHalfOpen: false,
  })
  const conn = new SmtpConn(socket)

  try {
    const greeting = await conn.readReply()
    if (greeting.code !== 220) {
      throw new SmtpSendError(`服务器问候异常：${greeting.code} ${greeting.text.slice(0, 120)}`)
    }

    const caps = await conn.ehlo()

    // 587/25：明文 EHLO 后按 advertised 能力升级 TLS。别在已加密(465)时再来一遍。
    if (!tlsFirst) {
      if (!caps.starttls) {
        throw new SmtpSendError("服务器不支持 STARTTLS，拒绝明文发送（需要 465 隐式 TLS 或开启 STARTTLS）")
      }
      await conn.startTls()
      await conn.ehlo()
    }

    // 认证：优先 PLAIN（一条命令），否则 LOGIN（两步）
    if (caps.auth.includes("PLAIN") || caps.auth.length === 0) {
      const payload = b64utf8(`\u0000${account.username}\u0000${account.password}`)
      await conn.cmd(`AUTH PLAIN ${payload}`, [235])
    } else if (caps.auth.includes("LOGIN")) {
      await conn.cmd("AUTH LOGIN", [334])
      await conn.cmd(b64utf8(account.username), [334])
      await conn.cmd(b64utf8(account.password), [235])
    } else {
      throw new SmtpSendError(`服务器不支持的认证方式：${caps.auth.join("/") || "无"}（需要 PLAIN 或 LOGIN）`)
    }

    await conn.cmd(`MAIL FROM:<${account.fromEmail}>`, [250])
    await conn.cmd(`RCPT TO:<${msg.to}>`, [250, 251])
    await conn.cmd("DATA", [354])
    await conn.cmd(`${buildMessage(account, msg)}\r\n.`, [250])
  } finally {
    await conn.close().catch(() => {})
  }
}