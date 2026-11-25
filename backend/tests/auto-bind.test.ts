import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAutoBindPrompt,
  parseAutoBindResult,
  sanitizeBindings,
  type AutoBindAssetsInput,
  type AutoBindShotInput,
} from '../src/services/auto-bind.js'

const shots: AutoBindShotInput[] = [
  {
    id: 11, number: 1, title: 'Anggur Tumpah',
    description: 'Mei menuangkan anggur merah, gelas tergelincir dari tangannya.',
    atmosphere: 'tegang', duration: 9, sceneId: null, characterIds: [], propIds: [],
  },
  {
    id: 12, number: 2, title: 'Permintaan Maaf',
    description: 'Mei meminta maaf kepada Daniel sambil menunduk.',
    atmosphere: 'cemas', duration: 9, sceneId: 3, characterIds: [1], propIds: [],
  },
]

const assets: AutoBindAssetsInput = {
  characters: [
    { id: 1, name: 'Mei', role: 'protagonist', description: 'pelayan muda' },
    { id: 2, name: 'Daniel', role: 'protagonist', description: 'CEO dingin' },
  ],
  scenes: [
    { id: 3, location: 'Upscale Restaurant', time: 'late night', description: 'restoran mewah' },
  ],
  props: [
    { id: 5, name: 'Signed Contract', type: 'document', description: 'kontrak bertanda tangan' },
  ],
}

test('buildAutoBindPrompt lists every shot and asset with IDs', () => {
  const prompt = buildAutoBindPrompt(shots, assets)
  assert.match(prompt, /storyboard_id=11/)
  assert.match(prompt, /storyboard_id=12/)
  assert.match(prompt, /Mei/)
  assert.match(prompt, /Daniel/)
  assert.match(prompt, /Upscale Restaurant/)
  assert.match(prompt, /Signed Contract/)
  assert.match(prompt, /SHOTS \(bind assets to each shot\)/)
  assert.match(prompt, /CHARACTERS:/)
  assert.match(prompt, /Currently bound: nothing/)
  assert.match(prompt, /Currently bound: scene=3, characters=\[1\]/)
})

test('parseAutoBindResult accepts plain JSON', () => {
  const out = parseAutoBindResult(
    '{"bindings": [{"storyboard_id": 11, "scene_id": 3, "character_ids": [1], "prop_ids": [5]}]}',
  )
  assert.deepEqual(out, [{ storyboard_id: 11, scene_id: 3, character_ids: [1], prop_ids: [5] }])
})

test('parseAutoBindResult strips fences and surrounding prose', () => {
  const out = parseAutoBindResult(
    'Here is the result:\n```json\n{"bindings": [{"storyboard_id": 12, "scene_id": null, "character_ids": [1, 2], "prop_ids": []}]}\n```\nDone.',
  )
  assert.deepEqual(out, [{ storyboard_id: 12, scene_id: null, character_ids: [1, 2], prop_ids: [] }])
})

test('parseAutoBindResult rejects non-JSON and missing bindings array', () => {
  assert.throws(() => parseAutoBindResult('no json here at all'), /not valid JSON/)
  assert.throws(() => parseAutoBindResult('{"other": []}'), /no "bindings" array/)
})

test('sanitizeBindings drops unknown IDs and dedupes', () => {
  const { bindings, skipped } = sanitizeBindings(
    [
      { storyboard_id: 11, scene_id: 99, character_ids: [1, 2, 99], prop_ids: [5, 5, 7] },
      { storyboard_id: 999, scene_id: 3, character_ids: [1], prop_ids: [] },
      { storyboard_id: 11, scene_id: 3, character_ids: [], prop_ids: [] },
    ],
    shots,
    assets,
  )
  assert.equal(bindings.length, 1)
  assert.deepEqual(bindings[0], { storyboard_id: 11, scene_id: null, character_ids: [1, 2], prop_ids: [5] })
  assert.equal(skipped.length, 2)
  assert.equal(skipped[0].storyboard_id, 999)
  assert.equal(skipped[1].reason, 'duplicate entry, first one kept')
})
