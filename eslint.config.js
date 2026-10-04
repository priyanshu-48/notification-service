import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'dashboard/**', 'drizzle/**'] },
  ...tseslint.configs.recommended,
);
