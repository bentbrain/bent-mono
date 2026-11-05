import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const schemaMembers = new Set(['String', 'Int', 'Number', 'Boolean', 'Array', 'Literal', 'NullOr', 'Struct', 'Union',
  'filter', 'finite', 'maxItems', 'maxLength', 'minItems', 'minLength', 'nonNegative', 'optional', 'optionalWith',
  'pattern', 'positive', 'decodeUnknownSync']);
const readMethods = new Set(['trim', 'toLocaleUpperCase', 'toLocaleLowerCase', 'toLowerCase', 'replace', 'replaceAll',
  'slice', 'join', 'map', 'filter', 'some', 'every', 'entries', 'includes', 'get', 'has', 'test']);

// Only this small syntax subset can leave the renderer inventory. Unknown code
// keeps the broad qualification and drain. Check deferred callbacks as well as
// module initialization; a token blacklist cannot establish this boundary.
export function providerIdentityIsolated(source) {
  // Early request preflight runs before dependency installation. The compiler
  // remains mandatory when proving the narrower provider identity boundary.
  const ts = require('typescript');
  const file = ts.createSourceFile('identity.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) return false;
  const program = ts.createProgram(['identity.ts'], { noLib: true, noResolve: true }, {
    getSourceFile: name => name === 'identity.ts' ? file : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '', getDirectories: () => [],
    fileExists: name => name === 'identity.ts', readFile: name => name === 'identity.ts' ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const declaration = node => checker.getSymbolAtLocation(node)?.declarations?.[0];
  const schemaImport = node => ts.isIdentifier(node) && node.text === 'Schema' && declaration(node)?.kind === ts.SyntaxKind.ImportSpecifier;
  const schema = node => ts.isPropertyAccessExpression(node) && schemaImport(node.expression) && schemaMembers.has(node.name.text);
  const local = node => ts.isIdentifier(node) && [ts.SyntaxKind.Parameter, ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.BindingElement].includes(declaration(node)?.kind);
  const owned = (node, kind) => {
    if (!ts.isIdentifier(node)) return false;
    const declared = declaration(node);
    if (!declared || !ts.isVariableDeclaration(declared) || !declared.initializer || !(declared.parent.flags & ts.NodeFlags.Const)) return false;
    return kind === 'array' ? ts.isArrayLiteralExpression(declared.initializer) :
      ts.isNewExpression(declared.initializer) && declared.initializer.expression.getText(file) === kind;
  };
  const resolving = new Set();
  const resolveValue = (node, inspect) => {
    if (resolving.has(node)) return false;
    resolving.add(node);
    try { return inspect(); } finally { resolving.delete(node); }
  };
  const schemaValue = node => resolveValue(node, () => {
    if (schema(node)) return true;
    if (ts.isIdentifier(node)) {
      const declared = declaration(node);
      return declared && ts.isVariableDeclaration(declared) && declared.parent.parent.parent === file &&
        declared.initializer && schemaInitializer(declared.initializer);
    }
    return ts.isCallExpression(node) && schemaCall(node.expression);
  });
  const schemaCall = callee => schema(callee) || ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'pipe' && schemaValue(callee.expression);
  const schemaInitializer = node => schema(node) || ts.isCallExpression(node) && schemaCall(node.expression);
  const moduleValue = node => resolveValue(node, () => {
    if (schemaInitializer(node) || ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isIdentifier(node)) {
      const declared = declaration(node);
      return declared && ts.isVariableDeclaration(declared) && declared.pos < node.pos && declared.initializer && moduleValue(declared.initializer);
    }
    return ts.isObjectLiteralExpression(node) && node.properties.every(property =>
      ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && moduleValue(property.initializer) ||
      ts.isShorthandPropertyAssignment(property) && moduleValue(property.name) ||
      ts.isSpreadAssignment(property) && moduleValue(property.expression));
  });
  const imports = file.statements.filter(ts.isImportDeclaration);
  if (imports.length !== 1) return false;
  const imported = imports[0], bindings = imported.importClause?.namedBindings;
  if (!ts.isStringLiteral(imported.moduleSpecifier) || imported.moduleSpecifier.text !== 'effect' ||
    imported.importClause?.isTypeOnly || imported.importClause?.name || !bindings || !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 || bindings.elements[0].isTypeOnly || bindings.elements[0].propertyName ||
    bindings.elements[0].name.text !== 'Schema') return false;
  if (!file.statements.every(statement => ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement) && statement.body ||
    ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) &&
      statement.declarationList.declarations.every(item => ts.isIdentifier(item.name) && item.initializer && moduleValue(item.initializer)))) return false;

  let valid = true;
  const visit = node => {
    if (!valid || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isImportDeclaration(node)) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) || ts.isDeleteExpression(node) || ts.isWithStatement(node) ||
      ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isTaggedTemplateExpression(node) ||
      ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isComputedPropertyName(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) { valid = false; return; }
    if (ts.isPropertyAccessExpression(node) && ['prototype', '__proto__', 'constructor'].includes(node.name.text)) valid = false;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
      ['prototype', '__proto__', 'constructor'].includes(node.argumentExpression.text)) valid = false;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (!ts.isIdentifier(node.left) || !local(node.left))) valid = false;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && !local(node.operand)) valid = false;
    if (ts.isNewExpression(node) && (!ts.isIdentifier(node.expression) || !['URL', 'Map', 'Set'].includes(node.expression.text) || declaration(node.expression))) valid = false;
    if (ts.isCallExpression(node)) {
      const callee = node.expression, declared = ts.isIdentifier(callee) ? declaration(callee) : undefined;
      const localFunction = declared && (ts.isFunctionDeclaration(declared) && declared.body ||
        ts.isVariableDeclaration(declared) && declared.initializer && ts.isArrowFunction(declared.initializer));
      const globalCall = ts.isIdentifier(callee) && callee.text === 'String' && !declared;
      const globalMethod = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && !declaration(callee.expression) &&
        ['Number.isNaN', 'Date.parse'].includes(callee.getText(file));
      const decoded = ts.isCallExpression(callee) && schema(callee.expression) && callee.expression.name.text === 'decodeUnknownSync';
      const method = ts.isPropertyAccessExpression(callee) && !schemaImport(callee.expression) &&
        (readMethods.has(callee.name.text) ||
        callee.name.text === 'push' && owned(callee.expression, 'array') || callee.name.text === 'add' && owned(callee.expression, 'Set'));
      if (!(localFunction || globalCall || globalMethod || decoded || schemaCall(callee) || method)) valid = false;
    }
    if (ts.isIdentifier(node) && !declaration(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !(ts.isBindingElement(node.parent) && node.parent.propertyName === node)) {
      const parent = node.parent;
      const allowedGlobal = node.text === 'undefined' || node.text === 'String' && ts.isCallExpression(parent) && parent.expression === node ||
        ['URL', 'Map', 'Set'].includes(node.text) && ts.isNewExpression(parent) && parent.expression === node ||
        ts.isPropertyAccessExpression(parent) && parent.expression === node && ['Number.isNaN', 'Date.parse'].includes(parent.getText(file));
      if (!allowedGlobal) valid = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return valid;
}
