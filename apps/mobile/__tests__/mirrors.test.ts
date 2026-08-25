import {
  MIRROR_PRESETS,
  mirrorProbeUrl,
  testMirror,
} from '../src/mirrors/catalog';
import { normalizeMirrorBaseUrl } from '../src/preferences';

test('normalizes safe HTTPS mirror bases and rejects unsafe URLs', () => {
  expect(normalizeMirrorBaseUrl('https://mirror.example.com/alpine')).toBe(
    'https://mirror.example.com/alpine/',
  );
  expect(normalizeMirrorBaseUrl('http://mirror.example.com/')).toBeNull();
  expect(normalizeMirrorBaseUrl('https://user:pass@example.com/')).toBeNull();
  expect(
    normalizeMirrorBaseUrl('https://example.com/?token=secret'),
  ).toBeNull();
});

test('uses a concrete Alpine index as the mirror probe', () => {
  expect(mirrorProbeUrl('alpine', 'https://mirror.example.com/alpine/')).toBe(
    'https://mirror.example.com/alpine/v3.21/main/aarch64/APKINDEX.tar.gz',
  );
  expect(mirrorProbeUrl('npm', 'https://registry.example.com')).toBe(
    'https://registry.example.com/',
  );
});

test('measures a successful mirror with a bounded HEAD request', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  const times = [100, 142];
  const result = await testMirror('pip', 'https://pypi.org/simple/', {
    fetchImpl: fetchImpl as typeof fetch,
    now: () => times.shift() ?? 142,
  });

  expect(result).toEqual({ ok: true, latencyMs: 42, status: 200 });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://pypi.org/simple/',
    expect.objectContaining({ method: 'HEAD' }),
  );
});

test('ships official and China presets for every package family', () => {
  for (const category of ['alpine', 'pip', 'npm'] as const) {
    expect(MIRROR_PRESETS[category].some(preset => preset.official)).toBe(true);
    expect(
      MIRROR_PRESETS[category].some(preset => preset.region === 'China'),
    ).toBe(true);
  }
});
