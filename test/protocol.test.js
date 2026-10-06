'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, LineSplitter, encodeCommand, areaBitmask } = require('../lib/protocol');

test('parses zone messages', () => {
  assert.deepEqual(parseLine('"Z0071'), { type: 'zone', zone: 7, status: '1' });
  assert.deepEqual(parseLine('"Z1230\r'), { type: 'zone', zone: 123, status: '0' });
});

test('parses area messages', () => {
  assert.deepEqual(parseLine('"A00117'), { type: 'area', event: 'A', area: 1, user: '17' });
  assert.deepEqual(parseLine('"D00203'), { type: 'area', event: 'D', area: 2, user: '03' });
  assert.deepEqual(parseLine('"L001'), { type: 'area', event: 'L', area: 1, user: '' });
});

test('parses keypad, exit and entry delay messages seen on a real panel', () => {
  assert.deepEqual(parseLine('"U0030'), { type: 'user', user: 3 });
  assert.deepEqual(parseLine('"X0010'), { type: 'area', event: 'X', area: 1, user: '0' });
  assert.deepEqual(parseLine('"E0010'), { type: 'area', event: 'E', area: 1, user: '0' });
  assert.deepEqual(parseLine('"A001123'), { type: 'area', event: 'A', area: 1, user: '123' });
});

test('parses acknowledgements and unknown lines', () => {
  assert.deepEqual(parseLine('OK\r'), { type: 'ok' });
  assert.deepEqual(parseLine('ERROR'), { type: 'error' });
  assert.equal(parseLine('"Q123').type, 'unknown');
  assert.equal(parseLine('"Zabc').type, 'unknown');
});

test('line splitter reassembles fragmented and coalesced chunks', () => {
  const lines = [];
  const splitter = new LineSplitter((l) => lines.push(l));
  splitter.push(Buffer.from('"Z00'));
  splitter.push(Buffer.from('71\r\n"Z0070\r\nO'));
  splitter.push(Buffer.from('K\r\n'));
  assert.deepEqual(lines, ['"Z0071', '"Z0070', 'OK']);
});

test('area bitmask uses one bit per area', () => {
  const expected = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
  expected.forEach((bits, i) => assert.equal(areaBitmask(i + 1).charCodeAt(0), bits));
  assert.throws(() => areaBitmask(0), RangeError);
  assert.throws(() => areaBitmask(9), RangeError);
});

test('commands encode each bitmask as a single byte', () => {
  assert.deepEqual([...encodeCommand('W1234')], [...Buffer.from('\\W1234/')]);
  assert.deepEqual([...encodeCommand(`A${areaBitmask(8)}`)], [0x5c, 0x41, 0x80, 0x2f]);
});
