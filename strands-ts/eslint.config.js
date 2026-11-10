import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import tsdoc from 'eslint-plugin-tsdoc'

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
  // Apply SDK rules to src files
  sdkRules({
    files: ['src/**/*.ts'],
    tsconfig: './src/tsconfig.json',
  }),
  // Prevent non-vended-tools from importing vended-tools.
  // The node-only Docker/SSH sandbox backends are exempt: they vend tools via getTools() and
  // never reach the browser bundle.
  noVendedToolsImports({
    files: ['src/**/*.ts'],
    ignores: [
      'src/vended-tools/**/*.ts',
      'src/experimental/vended-tools/**/*.ts',
      'src/sandbox/docker.ts',
      'src/sandbox/ssh.ts',
      'src/sandbox/__tests__/docker.test.node.ts',
      'src/sandbox/__tests__/ssh.test.node.ts',
    ],
  }),
  // Then unit-test rules to UTs
  unitTestRules({
    files: ['src/**/__tests__/**/*.ts'],
    tsconfig: './src/tsconfig.json',
  }),
  // Apply UT rules to the integ tests
  unitTestRules({
    files: ['test/integ/**/*.ts'],
    tsconfig: './test/integ/tsconfig.json',
  }),
  // Then stricter integ test rules
  integTestRules({
    files: ['test/integ/**/*.ts'],
    tsconfig: './test/integ/tsconfig.json',
  }),
]

function sdkRules(options) {
  return {
    files: options.files,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: options.tsconfig,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      tsdoc: tsdoc,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'tsdoc/syntax': 'error',
    },
  }
}

function unitTestRules(options) {
  return {
    files: options.files,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: options.tsconfig,
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
    },
  }
}

function integTestRules(options) {
  return {
    files: options.files,
    languageOptions: {
      parserOptions: {
        project: options.tsconfig,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../src', '../src/**'],
              message:
                'Integration tests should use $/sdk/* path aliases instead of ../src. Test fixtures can import from $/sdk/*.',
            },
          ],
        },
      ],
    },
  }
}

function noVendedToolsImports(options) {
  return {
    files: options.files,
    ignores: options.ignores,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/vended-tools', '**/vended-tools/**'],
              message:
                'Core SDK files should not import from vended-tools. Vended tools are optional and independently importable.',
            },
          ],
        },
      ],
    },
  }
}
