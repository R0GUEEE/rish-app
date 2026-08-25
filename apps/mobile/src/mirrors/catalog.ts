import type { MirrorCategory } from '../preferences';
import { normalizeMirrorBaseUrl } from '../preferences';

export type MirrorPreset = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly region: 'Global' | 'China' | 'Asia' | 'Europe';
  readonly official?: boolean;
};

export type MirrorTestResult = {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly status?: number;
  readonly error?: string;
};

export const MIRROR_PRESETS: Readonly<
  Record<MirrorCategory, readonly MirrorPreset[]>
> = {
  alpine: [
    {
      id: 'alpine.official',
      name: 'Official CDN',
      baseUrl: 'https://dl-cdn.alpinelinux.org/alpine/',
      region: 'Global',
      official: true,
    },
    {
      id: 'alpine.tuna',
      name: 'Tsinghua TUNA',
      baseUrl: 'https://mirrors.tuna.tsinghua.edu.cn/alpine/',
      region: 'China',
    },
    {
      id: 'alpine.aliyun',
      name: 'Alibaba',
      baseUrl: 'https://mirrors.aliyun.com/alpine/',
      region: 'China',
    },
    {
      id: 'alpine.ustc',
      name: 'USTC',
      baseUrl: 'https://mirrors.ustc.edu.cn/alpine/',
      region: 'China',
    },
  ],
  pip: [
    {
      id: 'pip.official',
      name: 'Official PyPI',
      baseUrl: 'https://pypi.org/simple/',
      region: 'Global',
      official: true,
    },
    {
      id: 'pip.tuna',
      name: 'Tsinghua TUNA',
      baseUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
      region: 'China',
    },
    {
      id: 'pip.aliyun',
      name: 'Alibaba',
      baseUrl: 'https://mirrors.aliyun.com/pypi/simple/',
      region: 'China',
    },
    {
      id: 'pip.ustc',
      name: 'USTC',
      baseUrl: 'https://mirrors.ustc.edu.cn/pypi/web/simple/',
      region: 'China',
    },
  ],
  npm: [
    {
      id: 'npm.official',
      name: 'Official npm',
      baseUrl: 'https://registry.npmjs.org/',
      region: 'Global',
      official: true,
    },
    {
      id: 'npm.npmmirror',
      name: 'npmmirror',
      baseUrl: 'https://registry.npmmirror.com/',
      region: 'China',
    },
    {
      id: 'npm.huawei',
      name: 'Huawei',
      baseUrl: 'https://repo.huaweicloud.com/repository/npm/',
      region: 'China',
    },
    {
      id: 'npm.tencent',
      name: 'Tencent',
      baseUrl: 'https://mirrors.cloud.tencent.com/npm/',
      region: 'China',
    },
  ],
};

export function mirrorProbeUrl(
  category: MirrorCategory,
  baseUrl: string,
): string | null {
  const normalized = normalizeMirrorBaseUrl(baseUrl);
  if (normalized === null) return null;
  return category === 'alpine'
    ? `${normalized}v3.21/main/aarch64/APKINDEX.tar.gz`
    : normalized;
}

export async function testMirror(
  category: MirrorCategory,
  baseUrl: string,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {},
): Promise<MirrorTestResult> {
  const target = mirrorProbeUrl(category, baseUrl);
  if (target === null) return { ok: false, error: 'invalid-url' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(target, {
      method: 'HEAD',
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(now() - started));
    return response.ok
      ? { ok: true, latencyMs, status: response.status }
      : { ok: false, latencyMs, status: response.status, error: 'http' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'timeout'
          : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}
