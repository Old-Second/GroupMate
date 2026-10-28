import tseslint from 'typescript-eslint'

/**
 * Project-wide lint settings for TypeScript sources, tests and the remaining
 * legacy JavaScript.
 *
 * The rule set is deliberately narrow: it only reports patterns that are wrong
 * in this codebase regardless of style, so it can run as a required CI gate.
 * Formatting is not linted, and type-aware rules stay out because `tsc` already
 * type-checks `src/` and `test/` under `strict`.
 *
 * `no-empty` is the gate that keeps silent failures apart from deliberate ones:
 * a block that contains a comment passes, a bare `catch {}` does not. Logging,
 * rotation, cleanup and drain failures may still be swallowed - they just have
 * to say so in a comment. Existing bare blocks are recorded in
 * `eslint-suppressions.json`, so they do not fail CI but new ones do.
 */
const rules = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty-character-class': 'error',
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': 'error',
  'no-fallthrough': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-misleading-character-class': 'error',
  'no-octal': 'error',
  'no-prototype-builtins': 'error',
  'no-regex-spaces': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-shadow-restricted-names': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unused-labels': 'error',
  'no-useless-backreference': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': 'error',
  'no-with': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error'
  // `no-control-regex` stays off on purpose: control characters appear inside
  // the identifier and path validators, where rejecting them is the point.
}

export default [
  {
    ignores: [
      'dist/**',
      '.test-dist/**',
      'server/static/**',
      'resources/**',
      '**/*.min.js'
    ]
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules
  }
]
