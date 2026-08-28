const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

describe('Lucide React Native imports', () => {
  it('only uses deep icon entries exported for React Native', () => {
    const sourceRoot = path.resolve(__dirname, '../src');
    const appRoot = path.resolve(__dirname, '..');
    const specifiers = new Set();

    for (const filePath of sourceFiles(sourceRoot)) {
      const source = fs.readFileSync(filePath, 'utf8');
      const imports = source.matchAll(
        /['"](lucide-react-native\/icons\/[^'"]+)['"]/g,
      );

      for (const match of imports) {
        specifiers.add(match[1]);
      }
    }

    expect(specifiers.size).toBeGreaterThan(0);

    const resolution = spawnSync(
      process.execPath,
      [
        '--conditions=react-native',
        '-e',
        [
          'const specifiers = JSON.parse(process.argv[1]);',
          'const missing = specifiers.filter(specifier => {',
          '  try { require.resolve(specifier); return false; }',
          '  catch { return true; }',
          '});',
          'if (missing.length > 0) {',
          "  process.stderr.write(missing.join('\\n'));",
          '  process.exitCode = 1;',
          '}',
        ].join('\n'),
        JSON.stringify([...specifiers].sort()),
      ],
      {
        cwd: appRoot,
        encoding: 'utf8',
      },
    );

    if (resolution.error) throw resolution.error;
    expect({ status: resolution.status, stderr: resolution.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
  });
});
