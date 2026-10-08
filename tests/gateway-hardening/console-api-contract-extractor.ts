import ts from 'typescript';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const OPAQUE = '\u0000unresolved-route-value';
export interface ApiCall { readonly method: (typeof METHODS)[number]; readonly path: string }
type FunctionNode = ts.FunctionLikeDeclaration & { body?: ts.ConciseBody };
type Environment = ReadonlyMap<ts.Node, () => readonly string[]>;
const unresolved = () => new Error('el extractor no supo sacar la ruta de estas llamadas de client.ts');
const values = (rows: readonly string[]) => {
  const result = [...new Set(rows)];
  if (result.length > 32) throw new Error('route parameter union exceeds its bound');
  return result;
};
function visit(node: ts.Node, callback: (node: ts.Node) => void): void { callback(node); ts.forEachChild(node, child => { visit(child, callback); }); }
function functionNode(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}
function parentOf(node: { readonly parent?: ts.Node }): ts.Node | undefined { return node.parent; }
function owner(node: ts.Node): FunctionNode | undefined {
  for (let current = parentOf(node); current; current = parentOf(current)) if (functionNode(current)) return current;
  return undefined;
}
function name(node: FunctionNode): string | undefined {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
}
function binding(identifier: ts.Identifier): ts.VariableDeclaration | ts.ParameterDeclaration | ts.FunctionDeclaration | undefined {
  for (let scope = parentOf(identifier); scope; scope = parentOf(scope)) {
    if (functionNode(scope)) {
      const found = scope.parameters.find(row => ts.isIdentifier(row.name) && row.name.text === identifier.text);
      if (found) return found;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === identifier.text) return statement;
        if (ts.isVariableStatement(statement)) {
          const found = statement.declarationList.declarations.find(row => ts.isIdentifier(row.name) && row.name.text === identifier.text
            && row.getStart() < identifier.getStart());
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}
function finite(type: ts.TypeNode | undefined, at: ts.Node): readonly string[] {
  if (!type) return [OPAQUE];
  if (ts.isUnionTypeNode(type)) {
    if (!type.types.every(row => ts.isLiteralTypeNode(row) && ts.isStringLiteral(row.literal))) {
      throw new Error('route parameter union must contain only literals');
    }
    return type.types.map(row => (row as ts.LiteralTypeNode).literal.getText().slice(1, -1));
  }
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    for (let current: ts.Node | undefined = at; current; current = parentOf(current)) if (functionNode(current)) {
      const parameter = current.typeParameters?.find(row => row.name.text === type.typeName.getText());
      if (parameter?.constraint) return finite(parameter.constraint, current);
    }
  }
  return [OPAQUE];
}
function returns(node: FunctionNode): ts.Expression[] {
  if (!node.body) return [];
  if (!ts.isBlock(node.body)) return [node.body];
  const result: ts.Expression[] = [];
  const walk = (child: ts.Node): void => {
    if (functionNode(child)) return;
    if (ts.isReturnStatement(child) && child.expression) result.push(child.expression);
    ts.forEachChild(child, walk);
  };
  walk(node.body); return result;
}
function evaluate(expression: ts.Expression, env: Environment, depth = 0): readonly string[] {
  if (depth > 20) throw unresolved();
  const next = (child: ts.Expression, scope = env) => evaluate(child, scope, depth + 1);
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return next(expression.expression);
  if (ts.isConditionalExpression(expression)) return values([...next(expression.whenTrue), ...next(expression.whenFalse)]);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return values(next(expression.left).flatMap(left => next(expression.right).map(right => left + right)));
  }
  if (ts.isTemplateExpression(expression)) {
    let paths = [expression.head.text];
    for (const span of expression.templateSpans) paths = values(paths.flatMap(prefix => next(span.expression).map(value => prefix + value + span.literal.text)));
    return paths;
  }
  if (ts.isIdentifier(expression)) {
    const found = binding(expression); if (!found) return [OPAQUE];
    if (ts.isParameter(found)) finite(found.type, found);
    if (env.has(found)) return env.get(found)?.() ?? [OPAQUE];
    if (ts.isParameter(found)) return found.initializer ? next(found.initializer) : finite(found.type, found);
    if (ts.isVariableDeclaration(found) && found.initializer) return next(found.initializer);
    throw unresolved();
  }
  if (ts.isCallExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'toString') return ['1'];
    if (ts.isIdentifier(expression.expression)) {
      if (['encodeURIComponent', 'String'].includes(expression.expression.text)) return expression.arguments[0] ? next(expression.arguments[0]) : ['1'];
      const found = binding(expression.expression);
      const helper = found && (ts.isFunctionDeclaration(found) ? found
        : ts.isVariableDeclaration(found) && found.initializer && functionNode(found.initializer) ? found.initializer : undefined);
      if (helper) {
        const local = new Map(env);
        for (const [index, parameter] of helper.parameters.entries()) {
          const argument = expression.arguments[index];
          local.set(parameter, () => argument ? next(argument) : parameter.initializer ? next(parameter.initializer) : finite(parameter.type, parameter));
        }
        const result = returns(helper).flatMap(value => next(value, local));
        if (result.length > 0) return values(result);
      }
    }
    throw unresolved();
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isNewExpression(expression)) return [OPAQUE];
  if (expression.kind === ts.SyntaxKind.UndefinedKeyword || ts.isNumericLiteral(expression)) return ['1'];
  throw unresolved();
}
function callEnvironments(node: ts.CallExpression, source: ts.SourceFile): Environment[] {
  const enclosing = owner(node); const label = enclosing && name(enclosing);
  if (!enclosing || !label || label === 'request') return [new Map()];
  const references: ts.CallExpression[] = [];
  visit(source, current => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === label) references.push(current);
  });
  if (references.length === 0) return [new Map()];
  return references.map(call => {
    const env = new Map<ts.Node, () => readonly string[]>();
    for (const [index, parameter] of enclosing.parameters.entries()) {
      const argument = call.arguments[index];
      env.set(parameter, () => argument ? evaluate(argument, new Map()) : parameter.initializer ? evaluate(parameter.initializer, env) : finite(parameter.type, parameter));
    }
    return env;
  });
}
function methodExpression(options: ts.Expression | undefined): ts.Expression | undefined {
  if (!options) return undefined;
  if (ts.isIdentifier(options)) {
    const found = binding(options);
    if (found && ts.isVariableDeclaration(found) && found.initializer) return methodExpression(found.initializer);
    throw unresolved();
  }
  if (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment)) throw unresolved();
  const property = options.properties.find(row => row.name && (ts.isStringLiteral(row.name) ? row.name.text : row.name.getText()) === 'method');
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name;
  if (property) throw unresolved();
  return undefined;
}
export function extractClientCalls(text: string): ApiCall[] {
  const source = ts.createSourceFile('console-client.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: ApiCall[] = [];
  visit(source, node => {
    if (!ts.isCallExpression(node) || !(ts.isIdentifier(node.expression) && node.expression.text === 'request'
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'request')) return;
    const route = node.arguments[0]; if (!route) throw unresolved();
    if (ts.isIdentifier(route) && !binding(route)) throw unresolved();
    for (const env of callEnvironments(node, source)) {
      const paths = evaluate(route, env);
      const declaration = ts.isIdentifier(route) ? binding(route) : undefined;
      const carrier = declaration && ts.isParameter(declaration) && !env.has(declaration);
      if (paths.some(path => !path.startsWith('/v3/') && path.includes(OPAQUE)) && !carrier) throw unresolved();
      if (!paths.some(path => path.startsWith('/v3/'))) continue;
      const method = methodExpression(node.arguments[1]);
      const methods = method ? evaluate(method, env) : ['GET'];
      for (const path of paths) {
        if (!path.startsWith('/v3/')) continue;
        for (const value of methods) {
          if (!(METHODS as readonly string[]).includes(value)) throw new Error(`unsupported HTTP method in client.ts: ${value}`);
          calls.push({ method: value as ApiCall['method'], path: path.replaceAll(OPAQUE, '1') });
        }
      }
    }
  });
  return calls.filter((call, index) => calls.findIndex(row => row.method === call.method && row.path === call.path) === index);
}
