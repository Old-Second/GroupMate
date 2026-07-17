import lodash from 'lodash'
import { Config } from './config.js'
let puppeteer = {}
const MAX_BROWSER_START_TIMEOUT_MS = 120_000

function boundedBrowserTimeout () {
  const value = Number(Config.chromeTimeoutMS)
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1_000), MAX_BROWSER_START_TIMEOUT_MS)
    : MAX_BROWSER_START_TIMEOUT_MS
}

async function withinBrowserStartTimeout (operation, timeoutMs, lateCleanup) {
  let timer
  let timedOut = false
  const pending = Promise.resolve(operation)
  try {
    return await Promise.race([
      pending,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error('browser startup timed out'))
        }, timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) {
      pending.then(value => {
        try { void Promise.resolve(lateCleanup?.(value)).catch(() => undefined) } catch {}
      }, () => undefined)
    }
  }
}

class Puppeteer {
  constructor () {
    let args = [
      '--exclude-switches',
      '--no-sandbox',
      '--remote-debugging-port=51777',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-service-autorun',
      '--password-store=basic',
      '--system-developer-mode',
      '--mute-audio',
      '--disable-default-apps',
      '--no-zygote',
      '--disable-accelerated-2d-canvas',
      '--disable-web-security'
      // '--shm-size=1gb'
    ]
    if (Config.proxy) {
      args.push(`--proxy-server=${Config.proxy}`)
    }
    this.browser = false
    this.lock = false
    this.config = {
      headless: Config.headless,
      timeout: boundedBrowserTimeout(),
      args
    }

    if (Config.chromePath) {
      this.config.executablePath = Config.chromePath
    }

    this.html = {}
  }

  async initPupp () {
    if (!lodash.isEmpty(puppeteer)) return puppeteer
    puppeteer = (await import('puppeteer')).default
    // const pluginStealth = StealthPlugin()
    // puppeteer.use(pluginStealth)
    return puppeteer
  }

  /**
     * 初始化chromium
     */
  async browserInit () {
    await this.initPupp()
    if (this.browser) return this.browser
    if (this.lock) return false
    this.lock = true

    logger.mark('GroupMate Chromium 启动中...')
    const browserURL = 'http://127.0.0.1:51777'
    try {
      try {
        this.browser = await withinBrowserStartTimeout(
          puppeteer.connect({
            browserURL,
            protocolTimeout: boundedBrowserTimeout()
          }),
          boundedBrowserTimeout(),
          async browser => await browser?.disconnect?.()
        )
      } catch {
        /** 初始化puppeteer */
        this.browser = await withinBrowserStartTimeout(
          puppeteer.launch({ ...this.config, timeout: boundedBrowserTimeout() }),
          boundedBrowserTimeout(),
          async browser => await browser?.close?.()
        ).catch(() => {
          logger.error('groupmate.browser.start_failed')
          return false
        })
      }
    } finally {
      this.lock = false
    }

    if (!this.browser) {
      logger.error('groupmate.browser.unavailable')
      return false
    }

    logger.mark('GroupMate Chromium 启动成功')

    /** 监听Chromium实例是否断开 */
    this.browser.on('disconnected', (e) => {
      logger.info('Chromium实例关闭或崩溃！')
      this.browser = false
    })

    return this.browser
  }
}

export class ChatGPTPuppeteer extends Puppeteer {
  constructor (opts = {}) {
    super()
    const {
      debug = false
    } = opts

    this._debug = !!debug
  }

  async getBrowser () {
    if (this.browser) {
      return this.browser
    } else {
      return await this.browserInit()
    }
  }

  async close () {
    if (this.browser) {
      await this.browser.close()
    }
    this._page = null
    this.browser = null
  }
}

export default new ChatGPTPuppeteer()
