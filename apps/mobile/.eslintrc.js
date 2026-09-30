module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // Dropping a field by destructuring it out of a rest spread is the idiom
    // this codebase uses to reshape a wider value. The base JavaScript rule
    // in the shared config permits it and the TypeScript override does not,
    // so the override is restated here with the same argument patterns the
    // shared config already chose.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
};
