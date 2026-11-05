import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

// Follow runtime imports, including lazy client imports and package re-exports.
// A DTO schema must never bring the server's HTTP API definitions into a browser.
it("keeps browser API and order-management graphs free of server HTTP contracts", () => {
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: fileURLToPath(new URL("../", import.meta.url)),
    paths: { "@/*": ["./*"] },
  };
  const pending = [
    "./design-api.ts",
    "./product-api.ts",
    "../app/manage-order/manage-order.tsx",
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  const visited = new Set<string>();
  const forbidden: string[] = [];

  for (let path = pending.pop(); path; path = pending.pop()) {
    if (visited.has(path)) continue;
    visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeImports(source)) {
      if (specifier === "@forever-tee/contracts" || specifier.startsWith("@effect/platform")) {
        forbidden.push(`${path} -> ${specifier}`);
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@/") &&
        !specifier.startsWith("@forever-tee/contracts")) continue;
      const resolution = ts.resolveModuleName(specifier, path, options, ts.sys).resolvedModule;
      expect(resolution, `Resolve ${specifier} from ${path}`).toBeDefined();
      if (resolution && !resolution.isExternalLibraryImport) pending.push(resolution.resolvedFileName);
      else if (resolution && specifier.startsWith("@forever-tee/contracts")) {
        pending.push(resolution.resolvedFileName);
      }
    }
  }

  expect(forbidden).toEqual([]);
});

function runtimeImports(source: ts.SourceFile) {
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const runtime = !clause || (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword && (clause.name !== undefined ||
        !bindings || ts.isNamespaceImport(bindings) || bindings.elements.some((item) => !item.isTypeOnly)));
      if (runtime) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause || !ts.isNamedExports(clause) || clause.elements.some((item) => !item.isTypeOnly)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
