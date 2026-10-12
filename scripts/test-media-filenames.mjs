import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mountComfyUIProxy } from '../lib/proxy.js'
import { ComfyUIClient } from '../lib/comfyui.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function clientHarness() {
  const context = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {}, useState: initial => [initial, () => {}],
    safeUrl: url => url,
  })
  for (const file of ['lightbox', 'card']) {
    const source = readFileSync(new URL(`../src/client/${file}.tsx`, import.meta.url), 'utf8')
      .replace(/^import .*$/gm, '').replace(/export /g, '')
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context)
  }
  return context
}
function elements(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(elements)] }

test('card and shared panel/lightbox links resolve the same original response filename', { timeout: 5000 }, async () => {
  const client = clientHarness()
  await fixture(async ({ base }) => {
    const files = ['ComfyUI_00008_.png', 'Кадр_00009.png']
    const urls = files.map(file => `${base}?${new URLSearchParams({ file })}`)
    for (let index = 0; index < files.length; index++) {
      const card = client.MediaItem({ item: { filename: files[index], url: urls[index], kind: 'image' }, t: key => key, onOpen() {} })
      const link = elements(card).find(element => element.type === 'a')
      assert.equal(link.props.download, files[index])
      const overlay = client.Lightbox({ images: urls, index, t: key => key, onClose() {}, onIndex() {} })
      const download = elements(overlay).find(element => element.type === 'a')
      // Empty download deliberately defers to Content-Disposition (also works for legacy URLs).
      assert.equal(download.props.download, '')
      for (const href of [link.props.href, download.props.href]) {
        const response = await fetch(href)
        assert.equal(name(response), files[index])
        await response.arrayBuffer()
      }
    }
  })
})

// Real HTTP at both seams: never forward the backend's filename suggestion.
async function fixture(run) {
  const calls = []
  const backend = createServer((q, s) => {
    calls.push({ url: q.url, method: q.method, range: q.headers.range })
    const url = new URL(q.url, 'http://localhost')
    if (url.pathname.startsWith('/history/')) {
      s.setHeader('content-type', 'application/json')
      s.end(JSON.stringify({ old: { outputs: { '1': { images: [{ filename: 'ComfyUI_00002_.png', subfolder: '', type: 'output' }] } } } }))
      return
    }
    const file = url.searchParams.get('filename')
    const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.flac') ? 'audio/flac' : 'image/png'
    s.writeHead(q.headers.range ? 206 : 200, {
      'content-type': type, 'content-disposition': 'attachment; filename="evil.html"',
      'content-length': q.headers.range ? '2' : '4',
      ...(q.headers.range ? { 'content-range': 'bytes 1-2/4' } : {}),
    })
    s.end(q.headers.range ? 'bc' : 'abcd')
  })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  let handler
  const client = new ComfyUIClient(`http://127.0.0.1:${backend.address().port}`, undefined, 1000, 1024)
  mountComfyUIProxy({}, {
    createClient: () => client, getApiKey: async () => undefined,
    listAssets: async () => [{ promptId: 'archived', media: [{ node: '1', index: 0, filename: 'ComfyUI_00003_.png', subfolder: 'saved', type: 'output' }] }],
  }, { register(route) { handler = route.handler; return () => {} } })
  const proxy = createServer((q, s) => handler(q, s))
  await new Promise(r => proxy.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${proxy.address().port}/comfyui/media`
  try { await run({ base, calls, get: (file, init) => fetch(`${base}?${new URLSearchParams({ file })}`, init) }) }
  finally { for (const server of [proxy, backend]) { server.closeAllConnections(); await new Promise(r => server.close(r)) } }
}
test('UTF-8 names and hostile basenames get safe bounded filenames without losing real extensions', { timeout: 5000 }, async () => {
  await fixture(async ({ get }) => {
    const cases = [
      ['Кадр café 😀_00001.png', 'Кадр café 😀_00001.png'],
      ['../../folder\\ComfyUI_00006_.png', 'ComfyUI_00006_.png'],
      ['bad"\r\nX-Evil: yes\u0000?.png', 'bad___X-Evil_ yes__.png'],
      ['CON.png', '_CON.png'], ['lpt1.flac', '_lpt1.flac'],
      ['..', 'media'], ['folder/', 'media'],
      ['hidden\u202egnp.png', 'hidden_gnp.png'],
      ['broken\ud800.png', 'broken_.png'],
      ['x'.repeat(400) + '.png', 'x'.repeat(176) + '.png'],
      ['я'.repeat(200) + '.png', 'я'.repeat(88) + '.png'],
      ["frame!'().png", "frame!'().png"],
    ]
    for (const [input, expected] of cases) {
      const response = await get(input)
      assert.equal(response.status, 200, input)
      assert.equal(name(response), expected)
      const fallback = /filename="([^"]*)";/.exec(response.headers.get('content-disposition'))?.[1]
      assert.ok(fallback)
      assert.doesNotMatch(fallback, /[^\x20-\x7e]|[\\/"<>:|?*%]/)
      assert.ok(Buffer.byteLength(expected) <= 180)
      assert.equal(response.headers.get('x-evil'), null)
      await response.arrayBuffer()
    }
  })
})

test('active content stays attachment/octet-stream with sandbox and nosniff; Range and HEAD keep filenames', { timeout: 5000 }, async () => {
  await fixture(async ({ get, calls }) => {
    for (const file of ['unsafe.svg', 'unsafe.html']) {
      const response = await get(file)
      assert.equal(name(response, 'attachment'), file)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'")
      await response.arrayBuffer()
    }
    for (const method of ['GET', 'HEAD']) {
      const response = await get('ComfyUI_00007_.mp4', { method, headers: { Range: 'bytes=1-2' } })
      assert.equal(response.status, 206)
      assert.equal(name(response), 'ComfyUI_00007_.mp4')
      assert.equal(response.headers.get('content-range'), 'bytes 1-2/4')
      assert.equal(response.headers.get('content-length'), '2')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'bc')
      assert.equal(calls.at(-1).method, method)
      assert.equal(calls.at(-1).range, 'bytes=1-2')
    }
    const response = await get('head.png', { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(name(response), 'head.png')
    assert.equal(response.headers.get('content-length'), '4')
    assert.equal(await response.text(), '')
  })
})

function name(response, disposition = 'inline') {
  const header = response.headers.get('content-disposition')
  assert.ok(header?.startsWith(`${disposition}; filename="`), header)
  assert.doesNotMatch(header, /evil|[\r\n]/)
  const match = /; filename\*=UTF-8''([^;]+)$/.exec(header)
  assert.ok(match, header)
  return decodeURIComponent(match[1])
}

test('distinct generated filenames survive direct, history and archived media HTTP routes', { timeout: 5000 }, async () => {
  await fixture(async ({ get, base }) => {
    for (const file of ['ComfyUI_00001_.png', 'ComfyUI_00004_.mp4', 'ComfyUI_00005_.flac']) {
      const response = await get(file)
      assert.equal(name(response), file)
      assert.equal(await response.text(), 'abcd')
    }
    for (const [prompt, file] of [['old', 'ComfyUI_00002_.png'], ['archived', 'ComfyUI_00003_.png']]) {
      const response = await fetch(`${base}?prompt=${prompt}&node=1&index=0`)
      assert.equal(name(response), file)
      await response.arrayBuffer()
    }
  })
})
