import { NativeModules, TurboModuleRegistry } from 'react-native';
import { LocalPrograms, parseProgramArguments, validProgramEntry } from '../src/native/runtime-programs';
import { otherWorkspaceId, programNative, receipt, root, runId } from '../test-fixtures/runtime-environments';
let native: ReturnType<typeof programNative>;
const turbo = jest.spyOn(TurboModuleRegistry, 'get');
const request = { schema_version: 1 as const, operation_id: runId, root, environment_id: 'python-3-13', entry_path: 'main.py', args: [] };
beforeEach(() => { native = programNative(); NativeModules.LocalPrograms = native; turbo.mockReturnValue(null); });
afterAll(() => { delete NativeModules.LocalPrograms; turbo.mockRestore(); });
test('passes literal arguments, spaces and shell-looking strings unchanged', async () => {
  const args = ['hello world', '$(echo nope)', 'a;rm', '', '--port', '8080'];
  expect(parseProgramArguments(JSON.stringify(args))).toEqual(args);
  await LocalPrograms.startProgram({ ...request, args });
  expect(native.startProgram).toHaveBeenCalledWith({ ...request, args });
});
test.each(['../main.py', '/main.py', './main.py', 'src//main.py', 'src/../main.py', 'src\\main.py', '', 'a\0b'])('refuses unsafe relative entry %s', async entry_path => {
  expect(validProgramEntry(entry_path)).toBe(false);
  await expect(LocalPrograms.startProgram({ ...request, entry_path })).rejects.toMatchObject({ code: 'E_PROGRAM_INVALID_REQUEST' });
  expect(native.startProgram).not.toHaveBeenCalled();
});
test.each(['[1]', '{}', '"hello"', '["\\u0000"]', JSON.stringify(Array.from({ length: 65 }, () => 'x')), JSON.stringify(['x'.repeat(4097)])])('refuses invalid args %#', value => {
  expect(parseProgramArguments(value)).toBeNull();
});
test('entry validation counts UTF8 bytes per path component', () => {
  expect(validProgramEntry(`${'中'.repeat(85)}.py`)).toBe(false);
  expect(validProgramEntry('src/你好.py')).toBe(true);
});
test('unavailable module produces safe explicit error', async () => {
  delete NativeModules.LocalPrograms;
  expect(LocalPrograms.isAvailable()).toBe(false);
  await expect(LocalPrograms.startProgram(request)).rejects.toMatchObject({ code: 'E_PROGRAM_UNAVAILABLE' });
});
test('does not substitute other workspace or run receipts', async () => {
  native.startProgram.mockResolvedValue(receipt({ workspace_id: otherWorkspaceId }));
  await expect(LocalPrograms.startProgram(request)).rejects.toMatchObject({ code: 'E_PROGRAM_NATIVE' });
  native.programStatus.mockResolvedValue(receipt({ run_id: otherWorkspaceId }));
  await expect(LocalPrograms.programStatus({ schema_version: 1, run_id: runId })).rejects.toMatchObject({ code: 'E_PROGRAM_NATIVE' });
});
test('renders bounded output text with terminal controls removed and preserves exit state', async () => {
  native.programStatus.mockResolvedValue(receipt({ status: 'completed', stdout: '\u001b[31m你好\u001b[0m\n', stderr: 'warning\t1\n', exit_code: 0 }));
  expect(await LocalPrograms.programStatus({ schema_version: 1, run_id: runId })).toMatchObject({ stdout: '你好\n', stderr: 'warning\t1\n', status: 'completed', exit_code: 0 });
  native.programStatus.mockResolvedValue(receipt({ stdout: '中'.repeat(90000) }));
  await expect(LocalPrograms.programStatus({ schema_version: 1, run_id: runId })).rejects.toMatchObject({ code: 'E_PROGRAM_NATIVE' });
});
test('native exception text never appears as program error', async () => {
  native.startProgram.mockRejectedValue({ code: 'UNKNOWN', message: '/private/token' });
  await expect(LocalPrograms.startProgram(request)).rejects.toMatchObject({ code: 'E_PROGRAM_NATIVE', message: 'E_PROGRAM_NATIVE' });
});
