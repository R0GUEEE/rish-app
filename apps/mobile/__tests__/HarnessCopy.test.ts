import { BUILTIN_HARNESSES } from '../src/harness/builtins';
import { createTranslator } from '../src/preferences';

test.each(['en-US', 'zh-CN'] as const)(
  'home and picker explain every built-in API adapter in %s',
  locale => {
    const t = createTranslator(locale);
    for (const key of ['home.description', 'harness.description'] as const) {
      const copy = t(key);
      for (const manifest of BUILTIN_HARNESSES.list())
        expect(copy).toContain(manifest.name);
      expect(copy).toContain('API');
      expect(copy).toContain(
        locale === 'zh-CN' ? '所选服务' : 'selected service',
      );
    }
    expect(t('harness.description')).toContain('CLI');
  },
);
