/* eslint-disable no-control-regex -- Validate protocol text and remove terminal control characters. */
import { NativeModules, TurboModuleRegistry } from 'react-native';
import { nativeImplementationAvailable } from '../native/NativeImplementation';

export class RuntimeBridgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RuntimeBridgeError'; }
}
export function reject(code: string): never { throw new RuntimeBridgeError(code); }
export function exact(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) reject(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== keys.length || !keys.every(key => Object.hasOwn(descriptors, key))) reject(code);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const property = descriptors[key];
      if (!property || !('value' in property) || !property.enumerable) reject(code);
      result[key] = property.value;
    }
    return result;
  } catch { return reject(code); }
}
export function boundedArray(value: unknown, limit: number, code: string): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit ||
        Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) reject(code);
    return Array.from({ length: value.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (!property || !('value' in property) || !property.enumerable) reject(code);
      return property.value;
    });
  } catch { return reject(code); }
}
export const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
export const environmentId = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-z0-9][a-z0-9-]{0,95}$/u.test(value);
export const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
export const shortText = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function member<T extends string>(value: unknown, choices: readonly T[], code: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) reject(code);
  return value as T;
}
export function safeCode(error: unknown, codes: readonly string[], fallback: string): string {
  try {
    if (error && typeof error === 'object') {
      const property = Object.getOwnPropertyDescriptor(error, 'code');
      if (property && 'value' in property && typeof property.value === 'string' && codes.includes(property.value)) return property.value;
    }
  } catch { /* Error accessors and foreign messages never cross the bridge. */ }
  return fallback;
}
export function nativeModule(name: string, methods: readonly string[]): Record<string, (...args: unknown[]) => Promise<unknown>> | null {
  for (const load of [() => NativeModules[name], () => TurboModuleRegistry.get(name)]) {
    try {
      const module: unknown = load();
      if (!nativeImplementationAvailable(module)) continue;
      const result: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const method of methods) {
        const fn: unknown = Reflect.get(module as object, method);
        if (typeof fn !== 'function') throw new Error('unavailable');
        result[method] = fn.bind(module);
      }
      return result;
    } catch { /* Try the optional new-architecture module next. */ }
  }
  return null;
}
export function byteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
