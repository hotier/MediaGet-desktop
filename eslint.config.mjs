// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist-electron/**",
      "dist-renderer/**",
      "release/**",
      "node_modules/**",
      "../mediaGet/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 上游内核是 .js 弱类型，跨界调用点大量合理断言；保留 warn 级
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // renderer 的浏览器全局
    files: ["renderer/**/*.ts", "renderer/**/*.tsx"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly", console: "readonly" },
    },
  },
  {
    files: ["electron/**/*.ts", "core-adapter/**/*.ts", "tests/**/*.ts", "*.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  }
);
