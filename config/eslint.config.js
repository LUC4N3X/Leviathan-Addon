'use strict';

module.exports = [
  {
    files: [
      '../addon.js',
      '../manifest.js',
      '../core/**/*.js',
      '../providers/**/*.js',
      '../scripts/**/*.js',
      '../tests/**/*.js'
    ],
    ignores: [
      '../public/**',
      '../node_modules/**'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
      'no-dupe-keys': 'error',
      'no-unused-vars': 'off'
    }
  }
];
