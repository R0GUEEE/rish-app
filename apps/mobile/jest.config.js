module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^lucide-react-native/icons/.+$': '<rootDir>/__mocks__/lucideIcon.tsx',
  },
};
