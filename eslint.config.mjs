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
      // 本机诊断产物（崩溃探针输出、临时探针脚本）；.gitignore 已排除，lint 同样不该看
      ".cache/**",
      // 落地页（Astro）的生成物：框架自管，不属于本仓 lint 范围
      "landing/dist/**",
      "landing/.astro/**",
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
  },
  {
    // 诊断/运维类 CommonJS 脚本（scripts/*.cjs，Node 直接跑的运维件，
    // 不是 ESM 源码）：require/module 是宿主合法全局，ESM 规则不适用。
    // 根级 `*.cjs` 同理——commitlint 等工具的配置件只认 CommonJS 导出。
    // __dirname / fetch / Buffer 也是 Node 宿主全局（fetch 自 Node 18 起内置）。
    files: ["scripts/**/*.cjs", "scripts/**/*.js", "*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        // Node 18+ 宿主全局（下载超时用）
        AbortSignal: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      // 诊断脚本里的 best-effort 清理（rmSync 失败即忽略）是有意为之
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);
