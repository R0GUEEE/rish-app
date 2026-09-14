module.exports = {
  preset: '@react-native/jest-preset',
  // React act uses Node's immediate queue to flush asynchronous renders.
  fakeTimers: { doNotFake: ['setImmediate', 'nextTick'] },
  moduleNameMapper: {
    '^lucide-react-native/icons/.+$': '<rootDir>/__mocks__/lucideIcon.tsx',
  },
};
