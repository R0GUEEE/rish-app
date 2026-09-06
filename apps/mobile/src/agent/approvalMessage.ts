export const MAX_APPROVAL_MESSAGE_BYTES = 2000;

/** Count the exact wire representation; unpaired UTF-16 surrogates are invalid. */
export function approvalMessageBudget(message: string): {
  bytes: number | null;
  valid: boolean;
} {
  let bytes = 0;
  for (let index = 0; index < message.length; index += 1) {
    const unit = message.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= message.length) return { bytes: null, valid: false };
      const next = message.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return { bytes: null, valid: false };
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { bytes: null, valid: false };
    } else bytes += 3;
  }
  return { bytes, valid: bytes <= MAX_APPROVAL_MESSAGE_BYTES };
}
