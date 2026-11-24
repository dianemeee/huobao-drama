import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { asc, eq } from 'drizzle-orm'

// 先把真实库指到临时文件，再动态导入带副作用的 db 模块，避免碰到开发库
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-split-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { schema } = await import('../src/db/index.js')
const { splitStoryboardIfTooLong } = await import('../src/services/video-split.js')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')

function testDb() {
  const sqlite = new Database(':memory:')
  initSqliteSchema(sqlite)
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

const PROMPT_15S = [
  '@Mei @Kafe',
  'Mei menuangkan anggur, gelas jatuh ke lantai.',
  'Daniel menatap dingin, tidak berkata apa-apa.',
  'Mei: "Maaf, Tuan, saya tidak sengaja."',
  'Daniel: "Kamu dipecat. Keluar."',
  'Mei menunduk, kontrak tergeletak di atas meja.',
].join('\n')

const DESC_15S = [
  '【镜头1】Mei menuangkan anggur.',
  '【镜头2】Daniel menatap dingin.',
  '【镜头3】Mei meminta maaf.',
  '【镜头4】Daniel mengusir Mei.',
].join('\n')

test('a 15s storyboard splits into two ordered rows sharing the first frame', async () => {
  const { sqlite, db } = testDb()
  try {
    const ts = new Date().toISOString()
    const first = db.insert(schema.storyboards).values({
      episodeId: 1, sceneId: 7, storyboardNumber: 1, title: 'Lenteng',
      description: DESC_15S, videoPrompt: PROMPT_15S, duration: 15,
      firstFrameImage: 'static/frames/frame1.png', status: 'completed',
      videoUrl: 'static/videos/old.mp4', createdAt: ts, updatedAt: ts,
    }).returning().get()
    const next = db.insert(schema.storyboards).values({
      episodeId: 1, storyboardNumber: 2, title: 'Next', duration: 8,
      createdAt: ts, updatedAt: ts,
    }).returning().get()
    db.insert(schema.storyboardCharacters).values({ storyboardId: first.id, characterId: 11 }).run()
    db.insert(schema.storyboardProps).values({ storyboardId: first.id, propId: 22 }).run()

    const result = await splitStoryboardIfTooLong(db, first.id, 'muse')
    assert.equal(result.split, true)
    assert.equal(result.chunks.length, 2)
    assert.deepEqual(result.chunks.map((c) => c.durationSeconds), [9, 6])

    const rows = db.select().from(schema.storyboards).orderBy(asc(schema.storyboards.storyboardNumber)).all()
    assert.equal(rows.length, 3)
    const [chunk1, chunk2, moved] = rows
    assert.equal(chunk1.id, first.id)
    assert.equal(chunk1.duration, 9)
    assert.equal(chunk1.title, 'Lenteng（1/2）')
    assert.equal(chunk1.videoUrl, null)
    assert.match(chunk1.videoPrompt!, /Maaf, Tuan/)
    assert.doesNotMatch(chunk1.videoPrompt!, /Kamu dipecat/)
    assert.equal(chunk2.storyboardNumber, 2)
    assert.equal(chunk2.duration, 6)
    assert.equal(chunk2.title, 'Lenteng（2/2）')
    assert.equal(chunk2.sceneId, 7)
    assert.equal(chunk2.firstFrameImage, 'static/frames/frame1.png')
    assert.match(chunk2.videoPrompt!, /Kamu dipecat/)
    assert.doesNotMatch(chunk2.videoPrompt!, /Maaf, Tuan/)
    assert.equal(moved.id, next.id)
    assert.equal(moved.storyboardNumber, 3)
    // 角色/道具绑定复制到新段
    const chars = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, chunk2.id)).all()
    assert.deepEqual(chars.map((c) => c.characterId), [11])
    const props = db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, chunk2.id)).all()
    assert.deepEqual(props.map((p) => p.propId), [22])
  } finally {
    sqlite.close()
  }
})

test('no split when the provider cap covers the segment, or a video task is running', async () => {
  const { sqlite, db } = testDb()
  try {
    const ts = new Date().toISOString()
    const sb = db.insert(schema.storyboards).values({
      episodeId: 1, storyboardNumber: 1, title: 'Seedance', duration: 15,
      videoPrompt: PROMPT_15S, createdAt: ts, updatedAt: ts,
    }).returning().get()
    // Seedance 上限 15 秒：15 秒分镜不拆
    assert.equal((await splitStoryboardIfTooLong(db, sb.id, 'volcengine')).split, false)
    // 有运行中的视频任务时也不拆
    db.insert(schema.sysTask).values({
      type: 'video', storyboardId: sb.id, status: 'processing',
      createdAt: ts, updatedAt: ts,
    }).run()
    assert.equal((await splitStoryboardIfTooLong(db, sb.id, 'muse')).split, false)
  } finally {
    sqlite.close()
  }
})
