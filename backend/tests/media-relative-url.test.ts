import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// STORAGE_PATH must be set before storage.ts is first loaded; this file only
// dynamic-imports the modules under test, so the temp dir applies.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-relative-url-'))
process.env.STORAGE_PATH = path.join(tmpRoot, 'static')
after(async () => { await fs.promises.rm(tmpRoot, { recursive: true, force: true }) })

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  return { url, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('resolveMediaUrl completes relative provider URLs against the base', async () => {
  const { resolveMediaUrl } = await import('../src/utils/storage.ts')
  assert.equal(
    resolveMediaUrl('/v1/media/abc.webp', 'https://muse.sukablyat.my.id'),
    'https://muse.sukablyat.my.id/v1/media/abc.webp',
  )
  assert.equal(
    resolveMediaUrl('/v1/media/abc.webp', 'https://muse.sukablyat.my.id/'),
    'https://muse.sukablyat.my.id/v1/media/abc.webp',
  )
  assert.equal(
    resolveMediaUrl('https://cdn.example/x.png', 'https://muse.sukablyat.my.id'),
    'https://cdn.example/x.png',
  )
  assert.equal(resolveMediaUrl('/v1/media/abc.webp'), '/v1/media/abc.webp')
  assert.equal(
    resolveMediaUrl('data:image/png;base64,AAA', 'https://muse.sukablyat.my.id'),
    'data:image/png;base64,AAA',
  )
  assert.equal(resolveMediaUrl('', 'https://muse.sukablyat.my.id'), '')
})

test('downloadFile downloads a relative image URL resolved against the provider base', async () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const server = await serve((req, res) => {
    if (req.url === '/v1/media/abc.webp') {
      res.setHeader('Content-Type', 'image/webp')
      res.end(webp)
      return
    }
    res.writeHead(404).end()
  })
  try {
    const { downloadFile } = await import('../src/utils/storage.ts')
    const rel = await downloadFile('/v1/media/abc.webp', 'images', server.url)
    assert.match(rel, /^static\/images\/[0-9a-f-]+\.webp$/)
    assert.deepEqual(
      await fs.promises.readFile(path.join(process.env.STORAGE_PATH!, rel.replace('static/', ''))),
      webp,
    )
  } finally {
    await server.close()
  }
})

test('downloadVideo downloads a relative video URL resolved against the provider base', async () => {
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
  const server = await serve((req, res) => {
    if (req.url === '/v1/media/abc.mp4') {
      res.end(video)
      return
    }
    res.writeHead(404).end()
  })
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-relative-video-'))
  try {
    const { downloadVideo } = await import('../src/services/video-download.ts')
    assert.equal(
      await downloadVideo('/v1/media/abc.mp4', 9, { root, baseUrl: server.url, retryDelayMs: 1 }),
      'static/videos/task-9.mp4',
    )
    assert.deepEqual(await fs.promises.readFile(path.join(root, 'videos/task-9.mp4')), video)
  } finally {
    await server.close()
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
