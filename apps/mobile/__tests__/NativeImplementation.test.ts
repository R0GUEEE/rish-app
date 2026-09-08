import {nativeImplementationAvailable} from '../src/native/NativeImplementation';
it('keeps legacy modules available but rejects explicit native placeholders', () => {
  expect(nativeImplementationAvailable({})).toBe(true);
  expect(nativeImplementationAvailable({implemented: true})).toBe(true);
  expect(nativeImplementationAvailable({implemented: false})).toBe(false);
  expect(nativeImplementationAvailable(null)).toBe(false);
});
it('supports HostObjects without descriptor enumeration', () => {
  const value = new Proxy({implemented: false}, {getOwnPropertyDescriptor() {throw new Error('unsupported');}});
  expect(nativeImplementationAvailable(value)).toBe(false);
});
