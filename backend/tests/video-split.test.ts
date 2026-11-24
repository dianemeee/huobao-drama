import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  maxSingleClipSeconds,
  parseVideoPrompt,
  splitDescription,
  splitDurations,
  splitVideoPrompt,
} from '../src/services/video-split.js'

const PROMPT_15S = [
  '@Mei @Kafe',
  'Mei menuangkan anggur, gelas jatuh ke lantai.',
  'Daniel menatap dingin, tidak berkata apa-apa.',
  'Mei: "Maaf, Tuan, saya tidak sengaja."',
  'Daniel: "Kamu dipecat. Keluar."',
  'Mei menunduk, kontrak tergeletak di atas meja.',
].join('\n')

test('provider single-clip caps mirror the adapters', () => {
  assert.equal(maxSingleClipSeconds('muse'), 10)
  assert.equal(maxSingleClipSeconds('volcengine'), 15)
  assert.equal(maxSingleClipSeconds('minimax'), 15)
  assert.equal(maxSingleClipSeconds('aliyun'), 30)
  assert.equal(maxSingleClipSeconds('unknown-provider'), 15)
  assert.equal(maxSingleClipSeconds(undefined), 15)
})

test('parseVideoPrompt separates the @reference header from the 3-second blocks', () => {
  const parts = parseVideoPrompt(PROMPT_15S)
  assert.equal(parts.header, '@Mei @Kafe')
  assert.equal(parts.blocks.length, 5)
  assert.equal(parts.blocks[3], 'Daniel: "Kamu dipecat. Keluar."')
  // 第一段是正文而不是信息头时，不误判
  const noHeader = parseVideoPrompt('Mei berjalan ke meja.\nDaniel menatapnya.')
  assert.equal(noHeader.header, null)
  assert.equal(noHeader.blocks.length, 2)
  // 单行提示词没有段结构
  assert.deepEqual(parseVideoPrompt('Mei berjalan ke meja.'), { header: null, blocks: [] })
})

test('a 15-second scene splits into 9s + 6s clips with dialogue kept in its own clip', () => {
  const chunks = splitVideoPrompt(PROMPT_15S, 10, 15)
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.map((c) => c.durationSeconds), [9, 6])
  const [first, second] = chunks
  // 每段只含自己的台词：道歉在第一段，解雇在第二段
  assert.match(first.prompt, /Maaf, Tuan/)
  assert.doesNotMatch(first.prompt, /Kamu dipecat/)
  assert.match(second.prompt, /Kamu dipecat/)
  assert.doesNotMatch(second.prompt, /Maaf, Tuan/)
  // 信息头两段都有；时长行写明每段从第 0 秒开始说台词
  assert.match(first.prompt, /@Mei @Kafe/)
  assert.match(second.prompt, /@Mei @Kafe/)
  assert.match(first.prompt, /\[时长\]本片段9秒.*第1段.*台词从第0秒开始/)
  assert.match(second.prompt, /\[时长\]本片段6秒.*第2段.*台词从第0秒开始/)
  // 第二段写明与上一段同一镜头、不重新开场
  assert.match(second.prompt, /同一镜头/)
  assert.match(second.prompt, /不要重新开场/)
})

test('a scene within the cap is returned unchanged', () => {
  const short = ['@Mei @Kafe', 'Mei menuangkan anggur.', 'Daniel menatap dingin.', 'Mei: "Maaf, Tuan."'].join('\n')
  const chunks = splitVideoPrompt(short, 10, 9)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].prompt, short)
  assert.equal(chunks[0].durationSeconds, 9)
  assert.doesNotMatch(chunks[0].prompt, /\[时长\]/)
})

test('free-text prompts split by duration without losing words', () => {
  const text = 'Mei berjalan ke meja. Daniel menatapnya tanpa bicara. Gelas jatuh ke lantai. Kontrak disodorkan. Mei terdiam.'
  const chunks = splitVideoPrompt(text, 10, 15)
  assert.deepEqual(chunks.map((c) => c.durationSeconds), [10, 5])
  const stripTiming = (p: string) => p.split('\n').filter((l) => !l.startsWith('[时长]')).join('')
  const rejoined = chunks.map((c) => stripTiming(c.prompt)).join('')
  assert.equal(rejoined.replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('splitDurations rebalances a remainder shorter than the clip minimum', () => {
  assert.deepEqual(splitDurations(15, 10), [10, 5])
  assert.deepEqual(splitDurations(12, 10), [6, 6])
  assert.deepEqual(splitDurations(25, 10), [10, 10, 5])
  assert.deepEqual(splitDurations(10, 10), [10])
})

test('splitDescription divides shot markers proportionally across chunks', () => {
  const desc = [
    '【镜头1】Mei menuangkan anggur.',
    '【镜头2】Daniel menatap dingin.',
    '【镜头3】Mei meminta maaf.',
    '【镜头4】Daniel mengusir Mei.',
  ].join('\n')
  const parts = splitDescription(desc, [3, 2])
  assert.equal(parts.length, 2)
  assert.match(parts[0], /【镜头1】/)
  assert.match(parts[0], /【镜头2】/)
  assert.doesNotMatch(parts[0], /【镜头3】/)
  assert.match(parts[1], /【镜头3】/)
  assert.match(parts[1], /【镜头4】/)
  // 无标记时按句子切；空描述返回空段
  const plain = splitDescription('Mei berjalan ke meja. Daniel menatapnya.', [1, 1])
  assert.equal(plain.length, 2)
  assert.deepEqual(splitDescription('', [1, 1]), ['', ''])
})
