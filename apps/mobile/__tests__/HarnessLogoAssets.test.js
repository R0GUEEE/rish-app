const fs = require('fs');
const path = require('path');

const { getHarnessLogoXml } = require('../src/assets/harness/logos');

test.each([
  ['dsh', 'deepseek-color.svg'],
  ['claude-code', 'claude-color.svg'],
  ['codex', 'codex-color.svg'],
  ['glm', 'zai.svg'],
])(
  'keeps %s geometry, colors and gradients identical to its source',
  (id, file) => {
    const original = fs.readFileSync(
      path.join(__dirname, '../src/assets/harness', file),
      'utf8',
    );

    expect(getHarnessLogoXml(id)).toBe(original.trim());
  },
);

test.each(['custom-harness', 'deepseek', 'toString', '__proto__', ''])(
  'does not assign a built-in logo to unknown ID %s',
  id => {
    expect(getHarnessLogoXml(id)).toBeUndefined();
  },
);
