// eslint.config.mjs
import js from "@eslint/js";
import next from "eslint-config-next";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";

export default [
  // Ignore generated/build folders
  { ignores: ["node_modules/**", ".next/**", "dist/**", "out/**"] },

  // Base JS recommendations + Next rules
  js.configs.recommended,
  next, // includes core-web-vitals in recent versions

  // TypeScript + project rules
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        // If you have a big monorepo or perf issues, leave project unset.
        // To enable full type-aware linting, add:
        // project: ['./tsconfig.json'],
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
      "unused-imports": unusedImports,
    },
    rules: {
      // ↓ Turn “unused” into warnings and allow underscore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          args: "after-used",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "unused-imports/no-unused-imports": "warn",

      // Tame these noisy rules
      "react-hooks/exhaustive-deps": "warn",
      "prefer-const": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        { "ts-ignore": "allow-with-description" },
      ],
    },
  },
];
