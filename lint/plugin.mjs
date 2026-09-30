// プロジェクト独自の oxlint ルール（ESLint 互換の JS プラグイン）。

/** @type {import("oxlint").Rule} */
const noNamedImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "named import（import { x } from ...）を禁止する。default import か namespace import を使う。",
    },
    messages: {
      noNamedImport:
        'named import は禁止です。`import * as name from "{{source}}"` か default import を使ってください。',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            context.report({
              node: specifier,
              messageId: "noNamedImport",
              data: { source: node.source.value },
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "toolbox" },
  rules: { "no-named-import": noNamedImport },
};
