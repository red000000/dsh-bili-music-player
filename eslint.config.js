/**
 * ESLint 扁平配置。
 *
 * 三类源码各有一套全局变量：Host 跑在 Node，Client 跑在浏览器，
 * 测试跑在 Node 且带 node:test。规则只开「能抓住真问题」的几条，
 * 不引入类型检查与格式化规则（格式化交给 Prettier）。
 */

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-console': 'off',
};

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  localStorage: 'readonly',
  Audio: 'readonly',
  MediaSource: 'readonly',
  Blob: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
};

export default [
  { ignores: ['client.js', 'node_modules/**'] },
  {
    files: ['index.js', 'src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules: sharedRules,
  },
  {
    files: ['client/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browserGlobals },
    rules: sharedRules,
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules: sharedRules,
  },
];
