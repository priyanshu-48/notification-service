import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dashboard/**', 'node_modules/**', 'drizzle/**'] },
  ...tseslint.configs.recommended,
);
