import assert from 'node:assert/strict';
import test from 'node:test';
import { primitiveFamilyDefinitionSchema as schema } from './primitiveFamilySchema.js';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import fs from 'node:fs';

test('generic geometry keeps explicit shape dimensions, instance scope and offsets through tool serialization', () => {
  const input = {category: 'Mechanical Equipment', typeName: 'Generic Unit', instanceDimensions: true,
    shapes: [{id: 'body', kind: 'box', widthFt: 2, depthFt: 1, heightFt: 3, originFeet: [0, 0, 0], rotationDegrees: 90},
      {id: 'flue', kind: 'cylinder', diameterFt: .5, heightFt: 1, originFeet: [1, .5, 3], rotationDegrees: 0}]};
  assert.deepEqual(schema.parse(input), input);
  assert.equal(schema.parse({...input, instanceDimensions: false}).instanceDimensions, false);
});

test('malformed dimensions cannot silently create different generic geometry', () => {
  const box = {widthFt: 1, depthFt: 2, heightFt: 3};
  for (const bad of [{...box, kind: 'sphere'}, {...box, diameterFt: 4}, {...box, widthFt: NaN},
    {...box, heightFt: 0}, {...box, depthFt: Infinity}, {...box, widthFt: .001}, {...box, heightFt: 1001},
    {...box, originFeet: [0, 0]}, {...box, rotationDegrees: 361}, {...box, id: '../body'}, {...box, size: 42},
    {kind: 'cylinder', heightFt: 2}]) assert.equal(schema.safeParse({shapes: [bad]}).success, false);
  assert.equal(schema.safeParse({shapes: [{...box, id: 'body'}, {...box, id: 'BODY'}]}).success, false);
  assert.equal(schema.safeParse({shapes: Array.from({length: 17}, (_, i) => ({...box, id: 'p' + i}))}).success, false);
  assert.equal(schema.safeParse({shapes: [box], category: 'Walls'}).success, false);
});

test('legacy absent geometry remains optional and shape defaults are explicit', () => {
  const result = schema.parse({shapes: [{widthFt: 1, depthFt: 1, heightFt: 1}]});
  assert.equal(result.shapes[0].kind, 'box');
  assert.equal(result.shapes[0].id, 'body');
  assert.equal(result.instanceDimensions, true);
});

test('actual MCP wire schema uses one coordinate-item schema while retaining exactly three bounded values', () => {
  const wire = toJsonSchemaCompat(z.object({geometry: schema.optional()}), {strictUnions: true, pipeStrategy: 'input'}) as any;
  const origin = wire.properties.geometry.properties.shapes.items.properties.originFeet;
  const here = new URL('./fixtures/generic-family-origin-tuple-312.json', import.meta.url);
  const retained = JSON.parse(fs.readFileSync(fs.existsSync(here) ? here : new URL('../../src/lib/fixtures/generic-family-origin-tuple-312.json', import.meta.url), 'utf8'));
  assert.match(retained.failure, /invalid type: map, expected a string/);
  const before = retained.inputSchema.properties.geometry.properties.shapes.items.properties.originFeet;
  assert.equal(Array.isArray(before.items), true);
  assert.deepEqual({...before, items: before.items[0]}, origin, 'Only tuple representation changes; coordinate constraints/default stay identical.');
  assert.equal(origin.type, 'array');
  assert.equal(Array.isArray(origin.items), false, 'The retained312 tuple wire schema was rejected at pinned CLI thread/start before any provider turn.');
  assert.equal(origin.items.type, 'number');
  assert.equal(origin.items.minimum, -10000); assert.equal(origin.items.maximum, 10000);
  assert.equal(origin.minItems, 3); assert.equal(origin.maxItems, 3);
  for (const values of [[0, 0], [0, 0, 0, 0], [0, Infinity, 0], [0, 10001, 0]])
    assert.equal(schema.safeParse({shapes: [{widthFt: 1, depthFt: 1, heightFt: 1, originFeet: values}]}).success, false);
});
