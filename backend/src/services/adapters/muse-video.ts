/**
 * muse2api muse-video 视频生成 Adapter
 * 端点: POST {baseUrl}/v1/videos，轮询 GET {baseUrl}/v1/videos/{taskId}
 * 响应: 创建返回 { id: "task-xxx", status }；完成时 { status: "completed", url }，
 *       地址也可能在 video.url / result.url 中返回。
 *
 * 注意：
 * - muse-video 单段最长 10 秒（超过按 10 秒截断）；音频由模型按 prompt 自带生成，
 *   不需要单独的音频参数，generateAudio 字段因此被忽略。
 * - muse2api 未配置 MUSE2API_PUBLIC_BASE 时返回相对地址（如 /v1/media/xxx.mp4），
 *   本 adapter 按 API baseUrl 补全为绝对地址后再交给下载流程。
 * - 仅支持单张首帧图片；参考视频暂不支持，会直接报错；参考音频会被忽略
 *   （音色信息已在提示词文本中，muse2api 没有音频输入字段）。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'muse-video'
/** muse-video 单段时长上限（实测行为），下限与 DramaClaw 工厂包一致 */
const MIN_DURATION_SECONDS = 3
const MAX_DURATION_SECONDS = 10

const COMPLETED_STATUSES = new Set(['completed', 'succeeded', 'success', 'done'])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled'])

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

/** 从任务响应中取视频地址：url → video.url → result.url → data.url */
function extractRawVideoUrl(result: any): string | null {
  if (!result || typeof result !== 'object') return null
  return result.url || result.video?.url || result.result?.url || result.data?.url || null
}

export class MuseVideoAdapter implements VideoProviderAdapter {
  provider = 'muse'

  /**
   * 最近一次请求使用的 API baseUrl。
   * parse* 方法拿不到 config，相对地址只能在这里补全；
   * 同一进程内 muse 配置共用一个 baseUrl，build* 每次调用都会刷新该值。
   */
  private lastBaseUrl = ''

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    if (model !== DEFAULT_MODEL) {
      throw new Error(`仅支持 muse-video 模型，当前: ${model}`)
    }
    this.lastBaseUrl = config.baseUrl || ''

    const prompt = (record.prompt || '').trim()
    const firstFrame = (record.firstFrameUrl || record.imageUrl || parseUrlArray(record.referenceImageUrls)[0] || '').trim()
    if (!prompt && !firstFrame) {
      throw new Error('视频生成需要 prompt 或首帧图片')
    }
    if (parseUrlArray(record.referenceVideoUrls).length > 0) {
      throw new Error('muse-video 暂不支持参考视频，请只用首帧图片')
    }
    // 参考音频直接忽略，不报错：音色信息已在提示词文本里（角色名 + “音色参考音频N”），
    // 而 muse2api 的视频接口本来就没有音频输入字段，传了也用不上。

    const body: any = {
      model,
      prompt,
      duration: this.normalizeDuration(record.duration),
      aspect_ratio: this.normalizeAspectRatio(record.aspectRatio),
      // muse-video 实际出片为 720p；1080p 同样收敛到 720p
      resolution: record.resolution === '480p' ? '480p' : '720p',
    }
    if (firstFrame) body.image = firstFrame

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const status = String(result?.status || '').toLowerCase()
    const videoUrl = this.resolveResultUrl(extractRawVideoUrl(result))
    if (videoUrl && COMPLETED_STATUSES.has(status)) {
      return { isAsync: false, videoUrl }
    }
    const taskId = result?.id || result?.task_id || result?.taskId
    if (taskId) {
      return { isAsync: true, taskId: String(taskId) }
    }
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    this.lastBaseUrl = config.baseUrl || ''
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '').toLowerCase()
    if (COMPLETED_STATUSES.has(status)) {
      const videoUrl = this.resolveResultUrl(extractRawVideoUrl(result))
      const duration = Number(result?.duration)
      return {
        status: 'completed',
        videoUrl: videoUrl || undefined,
        duration: Number.isFinite(duration) ? duration : undefined,
      }
    }
    if (FAILED_STATUSES.has(status)) {
      const err = result?.error
      const msg = typeof err === 'string'
        ? err
        : (err?.message || result?.message || JSON.stringify(err) || 'Video generation failed')
      return { status: 'failed', error: msg }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return this.resolveResultUrl(extractRawVideoUrl(result))
  }

  /** 相对地址按 API baseUrl 补全；绝对地址原样返回 */
  private resolveResultUrl(raw: string | null): string | null {
    if (!raw) return null
    try {
      return new URL(raw, this.lastBaseUrl || undefined).toString()
    } catch {
      return raw
    }
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, parsed))
  }

  private normalizeAspectRatio(aspectRatio?: string | null): string {
    const normalized = (aspectRatio || '').replace(/\s/g, '')
    if (normalized === '16:9' || normalized === '16/9') return '16:9'
    return '9:16'
  }
}
