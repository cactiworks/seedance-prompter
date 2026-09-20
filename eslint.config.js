import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'design/**', 'docs/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Ядро обязано работать в браузере и в тестах: без Node API, React и серверного кода.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'src/core — чистый TS: Node API запрещён.' },
            { group: ['react', 'react-dom', 'react/*'], message: 'src/core не зависит от React.' },
            { group: ['**/server/**', '**/web/**'], message: 'src/core не импортирует server и web.' },
            { group: ['hono', 'hono/*', 'vite'], message: 'src/core не зависит от серверных библиотек.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'process'],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', '**/server/**'], message: 'src/web не импортирует Node API и сервер (кроме типов API).' }] },
      ],
    },
  },
);
