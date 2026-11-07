import js from '@eslint/js';
import globals from 'globals';

/**
 * 工程基线阶段的 ESLint 规则：
 * - 先只拦真正的语法/引用问题，不强制重排现有代码。
 * - 未使用变量先降级为 warn，后续拆分模块时逐步清零。
 * - 现有代码中 `catch {}` 是有意为之，单独放行。
 */
export default [
  {
    ignores: ['node_modules/', 'docs/assets/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
