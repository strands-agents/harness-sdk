import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  eslint.configs.recommended,
  {
    rules: {
      // Disabled: TypeScript compiler catches all redeclaration cases and
      // understands value/type namespace merging (e.g., const + type with
      // same name). See https://typescript-eslint.io/rules/no-redeclare/
      'no-redeclare': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        ReadableStream: 'readonly',
        NodeJS: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './src/tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['bin/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['test/fixtures/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        URL: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
]
