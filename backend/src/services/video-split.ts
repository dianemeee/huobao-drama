/**
* 视频分镜拆分 — 单段时长超过视频模型上限时，把一个分镜拆成多段连续镜头。
*
* 背景：分镜按 8–15 秒设计（Seedance/MiniMax 单段最长 15 秒），而 muse-video
* 单段最长 10 秒。超过上限的分镜若直接生成，模型会把 15 秒的动作与台词压缩进
* 10 秒，结尾被砍掉。拆分后每段都不超过上限，总时长不变。
*
* 拆分保证三点（与 DramaClaw 工厂包的同名做法一致）：
* 1. 台词不迟到：video_prompt 按 3 秒一段切分，每段只含自己的台词，
* 且每段都注明“台词从第 0 秒开始、X 秒内说完”。
* 2. 镜头不变：所有分段共用同一张首帧图（firstFrameImage），同一场景、同一景别、
* 同一站位；后一段的提示词写明与上一段连续衔接、不重新开场。
* 3. 合并无感：拆分产生的是普通分镜行（按镜号顺序排在原位置），合并流程照常拼接。
*
* 注意：源码里不直接写全角方括号标记（分镜描述里的标记在正则中用
* \u3010 / \u3011 转义表示，以免写入时被处理掉）。
*/
import { and, desc, eq, gt} from 'drizzle-orm'
import { getInsertId, schema, type DB} from '../db/index.js'
import { now} from '../utils/response.js'

/** 各视频厂商单段时长上限（秒），与各适配器 normalizeDuration 的上限保持一致 */
export const PROVIDER_MAX_CLIP_SECONDS: Record<string, number> = {
muse: 10,
volcengine: 15,
minimax: 15,
aliyun: 30,
}

/** 未知厂商默认 15 秒：分镜本身按 8–15 秒设计，不超过该值时不拆 */
export function maxSingleClipSeconds(provider?: string | null): number {
if (!provider) return 15
return PROVIDER_MAX_CLIP_SECONDS[provider.toLowerCase()]?? 15
}

export const BLOCK_SECONDS = 3
/** muse-video 等模型的单段最短时长；余数过短时按下文重分配，避免出现 1–2 秒的碎段 */
const MIN_CLIP_SECONDS = 3

/** 分镜描述里的镜头标记用 String.fromCharCode(0x3010, 0x3011) 表示，不直接写全角方括号。 */
const SHOT_MARKER = String.fromCharCode(0x3010) + '镜头'
const SHOT_MARKER_OPEN = String.fromCharCode(0x3010)
const SHOT_MARKER_CLOSE = String.fromCharCode(0x3011)

export interface VideoPromptParts {
header: string | null
blocks: string[]
}

export interface VideoPromptChunk {
durationSeconds: number
prompt: string
blockCount: number
}

function splitLines(text: string): string[] {
return (text || '').split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
* 信息头只有一串 @引用（人物/场景/道具），几乎不含正文；据此与 3 秒段区分。
* 宁可漏判（当成普通段）也不误判：误判会把一段正文复制到每个分段里。
*/
function looksLikeHeader(line: string): boolean {
const mentions = line.match(/@[^，,、\s]+/g) || []
if (mentions.length === 0) return false
const rest = line.replace(/@[^，,、\s]+/g, '').replace(/[，,、\s（）()]/g, '')
if (rest.length!== 0) return false
return mentions.length >= 2 || /[，,、\s]/.test(line)
}

export function parseVideoPrompt(prompt: string): VideoPromptParts {
const lines = splitLines(prompt)
if (lines.length <= 1) return { header: null, blocks: []}
if (looksLikeHeader(lines[0])) return { header: lines[0], blocks: lines.slice(1)}
return { header: null, blocks: lines}
}

/** 按总时长贪心切分：15 秒按上限 10 秒切成 [10, 5]；余数不足 3 秒时与上一段均分 */
export function splitDurations(totalSeconds: number, maxSeconds: number): number[] {
if (!totalSeconds || totalSeconds <= 0) return []
if (totalSeconds <= maxSeconds) return [totalSeconds]
const out: number[] = []
let rest = totalSeconds
while (rest > maxSeconds) {
out.push(maxSeconds)
rest -= maxSeconds
}
if (rest > 0) out.push(rest)
if (out.length > 1 && out[out.length - 1] < MIN_CLIP_SECONDS) {
const last = out.pop()!
const prev = out.pop()!
const sum = prev + last
out.push(Math.ceil(sum / 2), Math.floor(sum / 2))
}
return out
}

function timingLine(durationSeconds: number, totalSeconds: number, index: number, count: number): string {
if (count <= 1) return ''
if (index === 0) {
return `[时长]本片段${durationSeconds}秒（本镜头共${totalSeconds}秒，第1段）。请在${durationSeconds}秒内完成本段全部动作与台词，台词从第0秒开始说，不要拖到片尾。`
}
return `[时长]本片段${durationSeconds}秒（本镜头共${totalSeconds}秒，第${index + 1}段）。与上一片段同一镜头、同一景别、同一站位、同一画面，动作与台词连贯衔接，不要重新开场、不要切换景别；台词从第0秒开始，${durationSeconds}秒内说完，不要拖到片尾。`
}

/** 按句切分（中英文句末标点都认），分隔符保留在句尾 */
function splitSentences(text: string): string[] {
const parts = text.match(/[^。！？；.!?\n]+[。！？；.!?\n]?/g)
return parts && parts.length? parts.map((s) => s.trim()).filter(Boolean): [text].filter(Boolean)
}

/** 无 3 秒段结构的自由文本：按时长比例切句子（句界优先），文字不丢失、不重复 */
function splitFreeText(text: string, totalSeconds: number, maxSeconds: number): VideoPromptChunk[] {
if (!text) return [{ durationSeconds: totalSeconds || 0, prompt: '', blockCount: 0}]
if (!totalSeconds || totalSeconds <= maxSeconds) {
return [{ durationSeconds: totalSeconds || 0, prompt: text, blockCount: 0}]
}
const durations = splitDurations(totalSeconds, maxSeconds)
const sentences = splitSentences(text)
const totalChars = sentences.join('').length || 1
const chunks: VideoPromptChunk[] = []
if (sentences.length >= durations.length) {
let used = 0
durations.forEach((duration, i) => {
const last = i === durations.length - 1
const budget = last? Infinity: Math.max(1, Math.round((duration / totalSeconds) * totalChars))
let part = ''
while (used < sentences.length && (part.length < budget || part === '')) {
part += sentences[used++]
}
const lines = [part.trim(), timingLine(duration, totalSeconds, i, durations.length)].filter(Boolean)
chunks.push({ durationSeconds: duration, prompt: lines.join('\n'), blockCount: 0})
})
return chunks
}
// 句子太少：按字数硬切
let offset = 0
durations.forEach((duration, i) => {
const last = i === durations.length - 1
const take = last? text.length - offset: Math.max(1, Math.round((duration / totalSeconds) * text.length))
const part = text.slice(offset, offset + take).trim()
offset += take
const lines = [part, timingLine(duration, totalSeconds, i, durations.length)].filter(Boolean)
chunks.push({ durationSeconds: duration, prompt: lines.join('\n'), blockCount: 0})
})
return chunks
}

/**
* 按 3 秒段切分 video_prompt：每段不超过 maxSeconds（按整段切，9 秒一段对应上限 10 秒）。
* 单段够放时原样返回，不加任何附加行，不改变现有行为。
*/
export function splitVideoPrompt(prompt: string, maxSeconds: number, totalSeconds?: number): VideoPromptChunk[] {
const text = (prompt || '').trim()
const { header, blocks} = parseVideoPrompt(text)
if (blocks.length === 0) {
return splitFreeText(text, totalSeconds || 0, maxSeconds)
}
const contentTotal = blocks.length * BLOCK_SECONDS
const total = totalSeconds && totalSeconds > 0? totalSeconds: contentTotal
const maxBlocks = Math.max(1, Math.floor(maxSeconds / BLOCK_SECONDS))
if (blocks.length <= maxBlocks) {
return [{ durationSeconds: total, prompt: text, blockCount: blocks.length}]
}
const count = Math.ceil(blocks.length / maxBlocks)
const chunks: VideoPromptChunk[] = []
for (let i = 0; i < blocks.length; i += maxBlocks) {
const part = blocks.slice(i, i + maxBlocks)
const duration = part.length * BLOCK_SECONDS
const lines = [...(header? [header]: []),...part]
const line = timingLine(duration, contentTotal, chunks.length, count)
if (line) lines.push(line)
chunks.push({ durationSeconds: duration, prompt: lines.join('\n'), blockCount: part.length})
}
return chunks
}

/** 按权重把一串条目连续分给各段（权重为每段的 3 秒段数或秒数） */
function distribute<T>(items: T[], weights: number[]): T[][] {
const total = weights.reduce((a, b) => a + b, 0) || 1
const groups: T[][] = weights.map(() => [])
let idx = 0
weights.forEach((w, gi) => {
const last = gi === weights.length - 1
const cumulative = weights.slice(0, gi + 1).reduce((a, b) => a + b, 0)
const end = last? items.length: Math.min(items.length, Math.round((cumulative / total) * items.length))
while (idx < end) groups[gi].push(items[idx++])
})
return groups
}

/**
* 按标记（优先）或句子，把描述切给各段；切不开时第一段拿全文、其余留空。
* 描述只作展示与提示词输入，真正驱动生成的是已切分的 video_prompt。
*/
export function splitDescription(description: string, chunkWeights: number[]): string[] {
const text = (description || '').trim()
if (!text) return chunkWeights.map(() => '')
const shotPattern = new RegExp(`(?=${SHOT_MARKER_OPEN}\u955c\u5934\\d+${SHOT_MARKER_CLOSE})`, 'g')
const shots = text.split(shotPattern).map((s) => s.trim()).filter(Boolean)
const hasMarker = shots.some((s) => s.startsWith(SHOT_MARKER))
if (shots.length >= 2 && hasMarker) {
return distribute(shots, chunkWeights).map((g) => g.join('\n'))
}
const sentences = splitSentences(text)
if (sentences.length >= chunkWeights.length) {
return distribute(sentences, chunkWeights).map((g) => g.join(''))
}
return chunkWeights.map((_, i) => (i === 0? text: ''))
}

export interface StoryboardSplitChunk {
storyboardId: number
durationSeconds: number
prompt: string
}

export interface StoryboardSplitResult {
split: boolean
storyboardIds: number[]
chunks: StoryboardSplitChunk[]
}

const EMPTY_SPLIT = (storyboardId: number): StoryboardSplitResult => ({
split: false,
storyboardIds: [storyboardId],
chunks: [],
})

/**
* 分镜过长时拆成多段：原行变第一段，其余段插在它后面（镜号顺延），共用首帧图与角色/道具绑定。
* 只在分镜时长超过该厂商单段上限、且无运行中视频任务时拆；否则原样返回。
* 拆分会清空原行的旧视频（旧视频是超长整段的截断版，需按新段重生成）。
*/
export async function splitStoryboardIfTooLong(
database: DB,
storyboardId: number,
provider?: string | null,
promptOverride?: string,
totalSecondsOverride?: number,
): Promise<StoryboardSplitResult> {
const [row] = await database.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
if (!row || row.deletedAt) return EMPTY_SPLIT(storyboardId)
const maxSeconds = maxSingleClipSeconds(provider)
const duration = Math.max(row.duration || 0, totalSecondsOverride || 0)
if (duration <= maxSeconds) return EMPTY_SPLIT(storyboardId)
const [running] = await database.select({ id: schema.sysTask.id}).from(schema.sysTask)
.where(and(
eq(schema.sysTask.type, 'video'),
eq(schema.sysTask.storyboardId, storyboardId),
eq(schema.sysTask.status, 'processing'),
))
if (running) return EMPTY_SPLIT(storyboardId)

const prompt = (promptOverride?? row.videoPrompt?? '').trim()
const chunks = splitVideoPrompt(prompt, maxSeconds, duration)
if (chunks.length <= 1) return EMPTY_SPLIT(storyboardId)
const descriptions = splitDescription(
row.description || '',
chunks.map((c) => (c.blockCount > 0? c.blockCount: c.durationSeconds)),
)
const ts = now()
const count = chunks.length
const newIds: number[] = []

database.transaction((tx) => {
// 后面的分镜按镜号倒序后移，给新段腾位置（倒序避免镜号冲突）
const following = tx.select({ id: schema.storyboards.id, storyboardNumber: schema.storyboards.storyboardNumber})
.from(schema.storyboards)
.where(and(
eq(schema.storyboards.episodeId, row.episodeId),
gt(schema.storyboards.storyboardNumber, row.storyboardNumber),
))
.orderBy(desc(schema.storyboards.storyboardNumber)).all()
for (const f of following) {
tx.update(schema.storyboards)
.set({ storyboardNumber: f.storyboardNumber + (count - 1), updatedAt: ts})
.where(eq(schema.storyboards.id, f.id)).run()
}
// 原行变第一段
tx.update(schema.storyboards).set({
duration: chunks[0].durationSeconds,
videoPrompt: chunks[0].prompt,
description: descriptions[0],
title: row.title? `${row.title}（1/${count}）`: row.title,
videoUrl: null,
subtitleUrl: null,
composedVideoUrl: null,
status: 'pending',
updatedAt: ts,
}).where(eq(schema.storyboards.id, row.id)).run()
// 其余段：复制原行（同场景、同首帧图 = 同一镜头），只换镜号、时长、提示词、描述
const charLinks = tx.select().from(schema.storyboardCharacters)
.where(eq(schema.storyboardCharacters.storyboardId, row.id)).all()
const propLinks = tx.select().from(schema.storyboardProps)
.where(eq(schema.storyboardProps.storyboardId, row.id)).all()
for (let i = 1; i < count; i++) {
const res = tx.insert(schema.storyboards).values({
episodeId: row.episodeId,
sceneId: row.sceneId,
storyboardNumber: row.storyboardNumber + i,
title: row.title? `${row.title}（${i + 1}/${count}）`: row.title,
location: row.location,
time: row.time,
shotType: row.shotType,
angle: row.angle,
movement: row.movement,
result: row.result,
atmosphere: row.atmosphere,
imagePrompt: row.imagePrompt,
videoPrompt: chunks[i].prompt,
bgmPrompt: row.bgmPrompt,
soundEffect: row.soundEffect,
description: descriptions[i],
duration: chunks[i].durationSeconds,
composedImage: row.composedImage,
firstFrameImage: row.firstFrameImage,
lastFrameImage: row.lastFrameImage,
referenceImages: row.referenceImages,
status: 'pending',
createdAt: ts,
updatedAt: ts,
}).run()
const newId = getInsertId(res)
newIds.push(newId)
for (const link of charLinks) {
tx.insert(schema.storyboardCharacters)
.values({ storyboardId: newId, characterId: link.characterId}).run()
}
for (const link of propLinks) {
tx.insert(schema.storyboardProps)
.values({ storyboardId: newId, propId: link.propId}).run()
}
}
})

const storyboardIds = [row.id,...newIds]
return {
split: true,
storyboardIds,
chunks: chunks.map((c, i) => ({
storyboardId: storyboardIds[i],
durationSeconds: c.durationSeconds,
prompt: c.prompt,
})),
}
}
