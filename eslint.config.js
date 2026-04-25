export default [
  {
    ignores: [
      'build/**',
      'dist/**',
      'node_modules/**',
      'node_modules*/**',
      '**/node_modules/**',
      '**/node_modules*/**',
      '.cdx-*/**',
      '**/.cdx-*/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
  },
];
