import {
  approvalMessageBudget,
  MAX_APPROVAL_MESSAGE_BYTES,
} from '../src/agent/approvalMessage';

const { Buffer } = jest.requireActual('buffer') as {
  Buffer: { byteLength(value: string, encoding: 'utf8'): number };
};

test.each([
  ['empty', '', true],
  ['ASCII boundary', 'x'.repeat(2000), true],
  ['ASCII overflow', 'x'.repeat(2001), false],
  ['two-byte boundary', 'é'.repeat(1000), true],
  ['Chinese boundary', '拒'.repeat(666) + 'ab', true],
  ['Chinese overflow', '拒'.repeat(667), false],
  ['emoji boundary', '😀'.repeat(500), true],
  ['emoji overflow', '😀'.repeat(501), false],
  ['mixed boundary', 'A中😀'.repeat(250), true],
  ['combining boundary', 'e\u0301'.repeat(666) + 'ab', true],
] as const)('%s counts exact UTF-8 bytes', (_label, message, valid) => {
  expect(approvalMessageBudget(message)).toEqual({
    bytes: Buffer.byteLength(message, 'utf8'),
    valid,
  });
  expect(MAX_APPROVAL_MESSAGE_BYTES).toBe(2000);
});

test.each(['\ud800', '\udc00', 'x\ud800', '\ud800x', '\ud800\ud800'])(
  'rejects unpaired surrogates %j',
  message => {
    expect(approvalMessageBudget(message)).toEqual({
      bytes: null,
      valid: false,
    });
  },
);
