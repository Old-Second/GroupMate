import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import {
  createQrCodeSvg,
  qrCodeBrowserScript
} from '../../src/runtime/presentation/qr-code-svg.js'

test('QR SVG accepts only a validated remote page URL and has no network dependency', () => {
  const valid = createQrCodeSvg('https://example.com/groupmate/reply/v1/' + 'a'.repeat(32))
  assert.equal(valid?.kind, 'qr_svg')
  assert.match(valid?.svg ?? '', /^<svg[^>]+viewBox="0 0 [0-9]+ [0-9]+"/)
  assert.match(valid?.svg ?? '', /<path[^>]+d="M/)
  assert.equal(createQrCodeSvg('http://127.0.0.1/groupmate/reply/v1/' + 'a'.repeat(32))?.kind, 'qr_svg')
  assert.equal(createQrCodeSvg('file:///tmp/reply'), null)
  assert.equal(createQrCodeSvg('about:blank'), null)
  assert.equal(createQrCodeSvg('https://user:pass@example.com/reply'), null)
  assert.equal(createQrCodeSvg(`https://example.com/${'界'.repeat(700)}`), null)

  const browser = qrCodeBrowserScript()
  assert.match(browser, /location\.origin\s*\+\s*location\.pathname/)
  assert.match(browser, /https\?:/)
  assert.doesNotMatch(browser, /fetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(|https?:\/\//)
})

test('browser QR obeys the exact flag and uses only canonical origin plus pathname', () => {
  const script = qrCodeBrowserScript()
  const execute = (showQRCode: boolean): number => {
    let appended = 0
    const holder = {
      hidden: true,
      textContent: '',
      appendChild: () => { appended++ }
    }
    vm.runInNewContext(script, {
      TextEncoder,
      location: {
        protocol: 'https:',
        origin: 'https://example.com',
        pathname: `/groupmate/reply/v1/${'a'.repeat(32)}`,
        search: '?secret=must-not-enter-qr',
        hash: '#secret'
      },
      document: {
        getElementById: (id: string) => id === 'groupmate-document'
          ? { textContent: JSON.stringify({ showQRCode }) }
          : id === 'groupmate-qr' ? holder : null,
        createElementNS: () => ({
          setAttribute: () => undefined,
          append: () => undefined
        })
      }
    })
    return appended
  }
  assert.equal(execute(false), 0)
  assert.equal(execute(true), 1)

  assert.deepEqual(
    createQrCodeSvg('https://example.com/path?secret=one#two'),
    createQrCodeSvg('https://example.com/path')
  )
})
