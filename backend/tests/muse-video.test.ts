import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MuseVideoAdapter } from '../src/services/adapters/muse-video'

const adapter = new MuseVideoAdapter()
const config = {
  provider: 'muse',
  baseUrl: 'https://muse.sukablyat.my.id',
  apiKey: 'sk-test',
  model: 'muse-video',
}

test('muse-video builds an image-to-video request against the muse2api endpoint', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 1,
    prompt: 'Kampung lane in Jakarta, residents sifting rubble, documentary style',
    firstFrameUrl: 'https://example.com/first.png',
    duration: 15,
    aspectRatio: '9:16',
    resolution: '1080p',
    generateAudio: true,
  })

  assert.equal(request.url, 'https://muse.sukablyat.my.id/v1/videos')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(request.body, {
    model: 'muse-video',
    prompt: 'Kampung lane in Jakarta, residents sifting rubble, documentary style',
    image: 'https://example.com/first.png',
    // 15s 超过 muse-video 单段上限 10s，按 10 秒截断；1080p 收敛到 720p
    duration: 10,
    aspect_ratio: '9:16',
    resolution: '720p',
  })
})

test('muse-video supports text-to-video, rejects unsupported models and reference videos', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 2,
    prompt: 'A quiet kampung alley at dawn',
    duration: 2,
    aspectRatio: '16:9',
  })
  assert.equal(request.body.image, undefined)
  assert.equal(request.body.duration, 3)
  assert.equal(request.body.aspect_ratio, '16:9')

  assert.throws(() => adapter.buildGenerateRequest(config, {
    id: 3,
    prompt: 'x',
    model: 'seedance-2-0',
  }), /仅支持 muse-video/)
  assert.throws(() => adapter.buildGenerateRequest(config, {
    id: 4,
    prompt: 'x',
    firstFrameUrl: 'https://example.com/first.png',
    referenceVideoUrls: JSON.stringify(['https://example.com/ref.mp4']),
  }), /暂不支持参考视频/)
  // 参考音频直接忽略：音色信息已在提示词文本里，muse2api 没有音频输入字段
  const withAudioRef = adapter.buildGenerateRequest(config, {
    id: 5,
    prompt: 'x',
    firstFrameUrl: 'https://example.com/first.png',
    referenceAudioUrls: JSON.stringify(['https://example.com/ref.mp3']),
  })
  assert.equal(withAudioRef.body.image, 'https://example.com/first.png')
})

test('muse-video parses async creation and polling responses', () => {
  // 先发一次生成请求，让 adapter 记住 API baseUrl，用于补全相对地址
  adapter.buildGenerateRequest(config, { id: 6, prompt: 'x' })

  assert.deepEqual(adapter.parseGenerateResponse({
    id: 'task_abc123',
    status: 'processing',
    progress: 10,
  }), { isAsync: true, taskId: 'task_abc123' })

  assert.deepEqual(adapter.buildPollRequest(config, 'task_abc123'), {
    url: 'https://muse.sukablyat.my.id/v1/videos/task_abc123',
    method: 'GET',
    headers: { Authorization: 'Bearer sk-test' },
    body: undefined,
  })

  const completed = adapter.parsePollResponse({
    id: 'task_abc123',
    status: 'completed',
    progress: 100,
    url: '/v1/media/abc123.mp4',
  })
  assert.equal(completed.status, 'completed')
  // muse2api 未配 MUSE2API_PUBLIC_BASE 时返回相对地址，adapter 必须补全
  assert.equal(completed.videoUrl, 'https://muse.sukablyat.my.id/v1/media/abc123.mp4')

  assert.deepEqual(adapter.parsePollResponse({
    id: 'task_abc123',
    status: 'completed',
    video: { url: 'https://cdn.example.com/final.mp4' },
    result: { url: 'https://cdn.example.com/other.mp4' },
    duration: 8,
  }), { status: 'completed', videoUrl: 'https://cdn.example.com/final.mp4', duration: 8 })

  assert.deepEqual(adapter.parsePollResponse({
    id: 'task_abc123',
    status: 'failed',
    error: { message: 'content filtered' },
  }), { status: 'failed', error: 'content filtered' })

  assert.equal(adapter.parsePollResponse({ id: 'task_abc123', status: 'processing', progress: 55 }).status, 'processing')
})
