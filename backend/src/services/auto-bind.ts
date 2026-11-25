/**
 * Auto-bind reference assets (characters / scenes / props) to storyboard shots.
 *
 * One click, one LLM call: the episode's active text model (qwen via OpenRouter
 * in the default setup) reads every shot description and matches the assets
 * that actually appear in it. Bindings are saved through the same link tables
 * the manual Reference Assets panel uses (storyboard_characters /
 * storyboard_props + storyboards.scene_id).
 *
 * Only OpenAI-compatible text configs are supported (provider 'openai').
 * The model only ever returns IDs from the lists it was given; every ID is
 * re-validated against the episode's real assets before anything is written.
 * When the model is unsure it must leave the field empty — a missing binding
 * is better than a wrong one.
 */
import { db, schema } from '../db/index.js'
import { asc, eq, inArray } from 'drizzle-orm'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { now } from '../utils/response.js'

export interface AutoBindShotInput {
  id: number
  number: number
  title?: string | null
  description?: string | null
  atmosphere?: string | null
  duration?: number | null
  location?: string | null
  time?: string | null
  sceneId?: number | null
  characterIds?: number[]
  propIds?: number[]
}

export interface AutoBindAssetsInput {
  characters: Array<{ id: number; name: string; role?: string | null; description?: string | null }>
  scenes: Array<{ id: number; location: string; time?: string | null; description?: string | null }>
  props: Array<{ id: number; name: string; type?: string | null; description?: string | null }>
}

export interface AutoBindBinding {
  storyboard_id: number
  scene_id: number | null
  character_ids: number[]
  prop_ids: number[]
}

export interface AutoBindSummary {
  episode_id: number
  model: string
  total_shots: number
  bound_shots: number
  unchanged_shots: number
  skipped: Array<{ storyboard_id: number; reason: string }>
  results: Array<AutoBindBinding & { storyboard_number: number; changed: boolean }>
}

const SYSTEM_PROMPT = [
  'You match reference assets to storyboard shots for a short drama.',
  'Reply with JSON ONLY, no prose, no markdown fences, no explanation.',
  'Shape: {"bindings": [{"storyboard_id": 12, "scene_id": 3, "character_ids": [1, 2], "prop_ids": [5]}]}',
  'Rules:',
  '- scene_id: exactly one scene per shot, the one whose location and time match the shot. null when the shot has no clear location or no scene matches.',
  '- character_ids: every character who appears, speaks, or is named in the shot description. [] when none appear.',
  '- prop_ids: every prop that appears or is used in the shot. [] when none appear.',
  '- Only use IDs from the lists below. Never invent an ID.',
  '- When unsure, leave the field empty. A missing binding is better than a wrong one.',
  '- Include one entry per shot, in shot-number order.',
].join('\n')

function oneLine(value: string | null | undefined, max = 400): string {
  const text = (value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function buildAutoBindPrompt(
  shots: AutoBindShotInput[],
  assets: AutoBindAssetsInput,
): string {
  const lines: string[] = []
  lines.push('SHOTS (bind assets to each shot):')
  for (const shot of shots) {
    const current: string[] = []
    if (shot.sceneId) current.push(`scene=${shot.sceneId}`)
    if (shot.characterIds?.length) current.push(`characters=[${shot.characterIds.join(', ')}]`)
    if (shot.propIds?.length) current.push(`props=[${shot.propIds.join(', ')}]`)
    lines.push(
      `- shot ${shot.number} (storyboard_id=${shot.id})` +
        (shot.title ? ` "${oneLine(shot.title, 80)}"` : '') +
        `: ${oneLine(shot.description)}` +
        (shot.atmosphere ? ` Atmosphere: ${oneLine(shot.atmosphere, 120)}.` : '') +
        (shot.location ? ` Location: ${oneLine(shot.location, 80)}.` : '') +
        (shot.time ? ` Time: ${oneLine(shot.time, 40)}.` : '') +
        (current.length ? ` Currently bound: ${current.join(', ')}.` : ' Currently bound: nothing.'),
    )
  }
  lines.push('')
  lines.push('CHARACTERS:')
  for (const c of assets.characters) {
    lines.push(`- id=${c.id} name="${c.name}" role="${oneLine(c.role, 60)}" — ${oneLine(c.description, 200)}`)
  }
  lines.push('')
  lines.push('SCENES:')
  for (const s of assets.scenes) {
    lines.push(`- id=${s.id} location="${s.location}" time="${oneLine(s.time, 40)}" — ${oneLine(s.description, 200)}`)
  }
  lines.push('')
  lines.push('PROPS:')
  for (const p of assets.props) {
    lines.push(`- id=${p.id} name="${p.name}" type="${oneLine(p.type, 60)}" — ${oneLine(p.description, 200)}`)
  }
  return lines.join('\n')
}

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const n = typeof item === 'number' ? item : Number(item)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Parse the model reply. Accepts raw JSON, ```json fences, or JSON with prose around it. */
export function parseAutoBindResult(text: string): AutoBindBinding[] {
  const cleaned = (text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Auto-bind reply was not valid JSON')
  }
  let parsed: any
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error('Auto-bind reply was not valid JSON')
  }
  const bindings = parsed?.bindings
  if (!Array.isArray(bindings)) {
    throw new Error('Auto-bind reply has no "bindings" array')
  }
  const out: AutoBindBinding[] = []
  for (const entry of bindings) {
    const storyboardId = Number(entry?.storyboard_id)
    if (!Number.isInteger(storyboardId) || storyboardId <= 0) continue
    const sceneId = entry?.scene_id == null ? null : Number(entry.scene_id)
    out.push({
      storyboard_id: storyboardId,
      scene_id: Number.isInteger(sceneId) && (sceneId as number) > 0 ? (sceneId as number) : null,
      character_ids: asIdList(entry?.character_ids),
      prop_ids: asIdList(entry?.prop_ids),
    })
  }
  return out
}

/**
 * Drop every ID the model returned that is not one of the episode's real
 * assets. Returns the cleaned bindings plus the entries that were dropped.
 */
export function sanitizeBindings(
  parsed: AutoBindBinding[],
  shots: AutoBindShotInput[],
  assets: AutoBindAssetsInput,
): { bindings: AutoBindBinding[]; skipped: Array<{ storyboard_id: number; reason: string }> } {
  const shotIds = new Set(shots.map(s => s.id))
  const sceneIds = new Set(assets.scenes.map(s => s.id))
  const characterIds = new Set(assets.characters.map(c => c.id))
  const propIds = new Set(assets.props.map(p => p.id))
  const bindings: AutoBindBinding[] = []
  const skipped: Array<{ storyboard_id: number; reason: string }> = []
  const seen = new Set<number>()
  for (const entry of parsed) {
    if (!shotIds.has(entry.storyboard_id)) {
      skipped.push({ storyboard_id: entry.storyboard_id, reason: 'unknown storyboard' })
      continue
    }
    if (seen.has(entry.storyboard_id)) {
      skipped.push({ storyboard_id: entry.storyboard_id, reason: 'duplicate entry, first one kept' })
      continue
    }
    seen.add(entry.storyboard_id)
    bindings.push({
      storyboard_id: entry.storyboard_id,
      scene_id: entry.scene_id != null && sceneIds.has(entry.scene_id) ? entry.scene_id : null,
      character_ids: [...new Set(entry.character_ids.filter(id => characterIds.has(id)))],
      prop_ids: [...new Set(entry.prop_ids.filter(id => propIds.has(id)))],
    })
  }
  return { bindings, skipped }
}

async function callAutoBindModel(prompt: string): Promise<{ model: string; text: string }> {
  const config = await getTextConfig()
  if (config.provider.toLowerCase() !== 'openai') {
    throw new Error(
      `Auto-bind needs an OpenAI-compatible text model (provider "openai"). Current text model provider is "${config.provider}".`,
    )
  }
  const baseUrl = getTextProviderBaseUrl(config).replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      ...(config.temperature != null ? { temperature: config.temperature } : {}),
    }
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      })
    } catch (err: any) {
      throw new Error(`Auto-bind text model request failed: ${err?.message || err}`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`Auto-bind text model request failed (${res.status}): ${detail || res.statusText}`)
    }
    const json: any = await res.json().catch(() => null)
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Auto-bind text model returned an empty reply')
    }
    try {
      parseAutoBindResult(text)
      return { model: config.model, text }
    } catch (err) {
      lastError = err as Error
      logTaskWarn('AutoBind', 'reply-parse-failed', { attempt })
      messages.push(
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: 'Your previous reply was not valid JSON. Reply with JSON ONLY, exactly in this shape: {"bindings": [{"storyboard_id": 12, "scene_id": 3, "character_ids": [1], "prop_ids": []}]}',
        },
      )
    }
  }
  throw lastError || new Error('Auto-bind reply was not valid JSON')
}

async function loadEpisodeAssets(episodeId: number): Promise<AutoBindAssetsInput> {
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))

  const characterIds = characterLinks.map(l => l.characterId)
  const sceneIds = sceneLinks.map(l => l.sceneId)
  const propIds = propLinks.map(l => l.propId)

  const [characters, scenes, props] = await Promise.all([
    characterIds.length
      ? db.select().from(schema.characters).where(inArray(schema.characters.id, characterIds))
      : Promise.resolve([]),
    sceneIds.length
      ? db.select().from(schema.scenes).where(inArray(schema.scenes.id, sceneIds))
      : Promise.resolve([]),
    propIds.length
      ? db.select().from(schema.props).where(inArray(schema.props.id, propIds))
      : Promise.resolve([]),
  ])

  return {
    characters: characters.map(c => ({ id: c.id, name: c.name, role: c.role, description: c.description || c.appearance || '' })),
    scenes: scenes.map(s => ({ id: s.id, location: s.location, time: s.time, description: s.prompt || s.finalPrompt || '' })),
    props: props.map(p => ({ id: p.id, name: p.name, type: p.type, description: p.description || p.prompt || '' })),
  }
}

async function syncLinks(
  table: typeof schema.storyboardCharacters | typeof schema.storyboardProps,
  storyboardId: number,
  ids: number[],
  idColumn: 'characterId' | 'propId',
): Promise<void> {
  await db.delete(table).where(eq(table.storyboardId, storyboardId))
  const unique = [...new Set(ids.filter(Boolean))]
  for (const id of unique) {
    await db.insert(table).values({ storyboardId, [idColumn]: id } as any)
  }
}

export async function autoBindEpisode(
  episodeId: number,
  storyboardIds?: number[],
): Promise<AutoBindSummary> {
  logTaskStart('AutoBind', 'auto-bind', { episodeId })
  const allShots = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
  const shots = storyboardIds?.length
    ? allShots.filter(s => storyboardIds.includes(s.id))
    : allShots
  if (!shots.length) {
    throw new Error('No storyboards in this episode yet')
  }
  const assets = await loadEpisodeAssets(episodeId)
  const assetCount = assets.characters.length + assets.scenes.length + assets.props.length
  if (!assetCount) {
    throw new Error('No characters, scenes or props in this episode yet. Extract assets first.')
  }

  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, shots.map(s => s.id)))
  const propLinks = await db.select().from(schema.storyboardProps)
    .where(inArray(schema.storyboardProps.storyboardId, shots.map(s => s.id)))
  const charMap = new Map<number, number[]>()
  const propMap = new Map<number, number[]>()
  for (const link of charLinks) {
    const list = charMap.get(link.storyboardId) || []
    list.push(link.characterId)
    charMap.set(link.storyboardId, list)
  }
  for (const link of propLinks) {
    const list = propMap.get(link.storyboardId) || []
    list.push(link.propId)
    propMap.set(link.storyboardId, list)
  }

  const shotInputs: AutoBindShotInput[] = shots.map(s => ({
    id: s.id,
    number: s.storyboardNumber,
    title: s.title,
    description: s.description,
    atmosphere: s.atmosphere,
    duration: s.duration,
    location: s.location,
    time: s.time,
    sceneId: s.sceneId,
    characterIds: charMap.get(s.id) || [],
    propIds: propMap.get(s.id) || [],
  }))

  const prompt = buildAutoBindPrompt(shotInputs, assets)
  logTaskProgress('AutoBind', 'calling-text-model', { shots: shots.length, assets: assetCount })
  const { model, text } = await callAutoBindModel(prompt)
  const parsed = parseAutoBindResult(text)
  const { bindings, skipped } = sanitizeBindings(parsed, shotInputs, assets)
  const byId = new Map(bindings.map(b => [b.storyboard_id, b]))

  const results: AutoBindSummary['results'] = []
  let boundShots = 0
  let unchangedShots = 0
  for (const shot of shotInputs) {
    const binding = byId.get(shot.id)
    if (!binding) {
      skipped.push({ storyboard_id: shot.id, reason: 'model returned no binding for this shot' })
      results.push({
        storyboard_id: shot.id, storyboard_number: shot.number,
        scene_id: shot.sceneId ?? null,
        character_ids: shot.characterIds || [], prop_ids: shot.propIds || [],
        changed: false,
      })
      unchangedShots++
      continue
    }
    const sameScene = (binding.scene_id ?? null) === (shot.sceneId ?? null)
    const sameChars = JSON.stringify([...binding.character_ids].sort()) === JSON.stringify([...(shot.characterIds || [])].sort())
    const sameProps = JSON.stringify([...binding.prop_ids].sort()) === JSON.stringify([...(shot.propIds || [])].sort())
    if (sameScene && sameChars && sameProps) {
      unchangedShots++
      results.push({
        storyboard_id: shot.id, storyboard_number: shot.number,
        scene_id: binding.scene_id, character_ids: binding.character_ids, prop_ids: binding.prop_ids,
        changed: false,
      })
      continue
    }
    await db.update(schema.storyboards)
      .set({ sceneId: binding.scene_id, updatedAt: now() })
      .where(eq(schema.storyboards.id, shot.id))
    await syncLinks(schema.storyboardCharacters, shot.id, binding.character_ids, 'characterId')
    await syncLinks(schema.storyboardProps, shot.id, binding.prop_ids, 'propId')
    boundShots++
    results.push({
      storyboard_id: shot.id, storyboard_number: shot.number,
      scene_id: binding.scene_id, character_ids: binding.character_ids, prop_ids: binding.prop_ids,
      changed: true,
    })
  }

  const summary: AutoBindSummary = {
    episode_id: episodeId,
    model,
    total_shots: shots.length,
    bound_shots: boundShots,
    unchanged_shots: unchangedShots,
    skipped,
    results,
  }
  logTaskSuccess('AutoBind', 'auto-bind', {
    episodeId, model, total: shots.length, bound: boundShots, unchanged: unchangedShots, skipped: skipped.length,
  })
  return summary
}
