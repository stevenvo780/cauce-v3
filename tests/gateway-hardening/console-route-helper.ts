import ts from 'typescript';

type Bindings = ReadonlyMap<string, string | undefined>;
interface ResolutionContext { node: ts.Node; bindings: Bindings; depth: number; scalar: boolean }
const EMPTY_BINDINGS: Bindings = new Map();

function sourceTree(source: string): ts.SourceFile {
  return ts.createSourceFile('console-client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function requestCall(tree: ts.SourceFile, before: number): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.getStart(tree) === before) found = node;
    if (node.pos <= before && node.end >= before) ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

export function requestRouteArgument(source: string, before: number): string | undefined {
  const tree = sourceTree(source);
  return requestCall(tree, before)?.arguments[0]?.getText(tree);
}

function scopeStatements(node: ts.Node): readonly ts.Statement[] | undefined {
  return ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : undefined;
}

function lookup(node: ts.Node, name: string): ts.VariableDeclaration | ts.FunctionDeclaration | undefined {
  const before = node.getStart();
  for (let scope = node.parent; ; scope = scope.parent) {
    const statements = scopeStatements(scope);
    if (statements !== undefined) {
      const matches: (ts.VariableDeclaration | ts.FunctionDeclaration)[] = [];
      for (const statement of statements) {
        if (statement.getStart() >= before) continue;
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) matches.push(statement);
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name) matches.push(declaration);
          }
        }
      }
      if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
    }
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => parameter.name.getText() === name)) return undefined;
    if (ts.isSourceFile(scope)) break;
  }
  return undefined;
}

function throwGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement !== undefined) return false;
  const body = statement.thenStatement;
  const single = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  return ts.isThrowStatement(body) || (single !== undefined && ts.isThrowStatement(single));
}

function resolveCall(expression: ts.CallExpression, context: ResolutionContext): string | undefined {
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const name = expression.expression.text;
  if (name === 'encodeURIComponent' || name === 'String') {
    const argument = expression.arguments[0];
    if (argument === undefined || expression.arguments.length !== 1) return undefined;
    const value = resolve(argument, context);
    const scalar = value ?? (context.scalar && ts.isIdentifier(argument) ? '1' : undefined);
    if (scalar === undefined) return undefined;
    return name === 'encodeURIComponent' ? encodeURIComponent(scalar) : scalar;
  }
  const declaration = lookup(context.node, name);
  if (declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined) return undefined;
  const statements = declaration.body.statements;
  const last = statements.at(-1);
  if (last === undefined || !ts.isReturnStatement(last) || last.expression === undefined
    || !statements.slice(0, -1).every(throwGuard)) return undefined;
  if (expression.arguments.length > declaration.parameters.length) return undefined;
  const bindings = new Map<string, string | undefined>();
  for (const [index, parameter] of declaration.parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) return undefined;
    const argument = expression.arguments[index];
    const value = argument === undefined
      ? parameter.initializer === undefined ? undefined : resolve(parameter.initializer, { ...context, node: parameter })
      : resolve(argument, { ...context, scalar: false });
    if (argument !== undefined && value === undefined && !ts.isIdentifier(argument)) return undefined;
    bindings.set(parameter.name.text, value);
  }
  return resolve(last.expression, { node: last, bindings, depth: context.depth + 1, scalar: false });
}

function resolve(expression: ts.Expression, context: ResolutionContext): string | undefined {
  if (context.depth > 12) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, context);
  if (ts.isIdentifier(expression)) {
    if (context.bindings.has(expression.text)) return context.bindings.get(expression.text);
    const declaration = lookup(context.node, expression.text);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
    if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    return resolve(declaration.initializer, { ...context, node: declaration, depth: context.depth + 1 });
  }
  if (ts.isCallExpression(expression)) return resolveCall(expression, context);
  if (ts.isTemplateExpression(expression)) {
    let path = expression.head.text;
    for (const span of expression.templateSpans) {
      const encodedSegment = path.startsWith('/v3/') && path.endsWith('/')
        && ts.isCallExpression(span.expression) && ts.isIdentifier(span.expression.expression)
        && span.expression.expression.text === 'encodeURIComponent';
      const queryValue = /[?&][^?&=]+=$/.test(path);
      const part = resolve(span.expression, { ...context, scalar: encodedSegment || queryValue });
      if (part === undefined) return undefined;
      path += part + span.literal.text;
    }
    return path;
  }
  return undefined;
}

export function helperRouteBefore(source: string, before: number, expression: string): string | undefined {
  const tree = sourceTree(source);
  const call = requestCall(tree, before);
  const contextNode = call ?? tree;
  const expressionTree = sourceTree(expression);
  const statement = expressionTree.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return undefined;
  return resolve(statement.expression, { node: contextNode, bindings: EMPTY_BINDINGS, depth: 0, scalar: false });
}

function querySuffixBefore(source: string, before: number, expression: string): string | undefined {
  const tree = sourceTree(source);
  const call = requestCall(tree, before);
  const expressionStatement = sourceTree(expression).statements[0];
  if (call === undefined || expressionStatement === undefined || !ts.isExpressionStatement(expressionStatement)
    || !ts.isCallExpression(expressionStatement.expression) || !ts.isIdentifier(expressionStatement.expression.expression)) return undefined;
  const declaration = lookup(call, expressionStatement.expression.expression.text);
  if (declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined) return undefined;
  const last = declaration.body.statements.at(-1);
  if (last === undefined || !ts.isReturnStatement(last) || last.expression === undefined || !ts.isConditionalExpression(last.expression)) return undefined;
  let returns = 0;
  function countReturns(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns += 1;
    ts.forEachChild(node, countReturns);
  }
  countReturns(declaration.body);
  if (returns !== 1) return undefined;
  const branches = [last.expression.whenTrue, last.expression.whenFalse];
  const empty = branches.some(branch => ts.isStringLiteralLike(branch) && branch.text === '');
  const query = branches.some(branch => ts.isTemplateExpression(branch) && branch.head.text.startsWith('?'));
  return empty && query ? '?1' : undefined;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
export interface ApiCall { readonly method: HttpMethod; readonly path: string }
function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let cursor = openParen; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, cursor);
    }
  }
  throw new Error('unbalanced call arguments while parsing the console API surface');
}

export function concreteSegments(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, '1').replace(/:[A-Za-z][A-Za-z0-9_]*/g, '1');
}

function rutaDeclaradaAntes(source: string, hasta: number, nombre: string): string | undefined {
  const patron = new RegExp(`const\\s+${nombre}\\s*=\\s*[\`'"]([^\`'"]*)[\`'"]`, 'g');
  let ultima: string | undefined;
  for (let m = patron.exec(source); m && m.index < hasta; m = patron.exec(source)) ultima = m[1];
  return ultima;
}

function esParametroDeLaFuncion(source: string, index: number, identificador: string): boolean {
  const firma = source.slice(Math.max(0, index - 240), index);
  const abre = firma.lastIndexOf('(');
  if (abre === -1) return false;
  return new RegExp(`[(,]\\s*${identificador}\\s*[:?,)]`).test(firma.slice(abre));
}

function concreteRouteVariants(source: string, before: number, path: string): string[] {
  const call = requestCall(sourceTree(source), before);
  let variants = [path];
  for (const match of path.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g)) {
    let scope = call?.parent;
    while (scope !== undefined && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    if (scope === undefined || !ts.isFunctionLike(scope)) continue;
    const parameter = scope.parameters.find(value => value.name.getText() === match[1]);
    if (parameter?.type === undefined || !ts.isUnionTypeNode(parameter.type)) continue;
    const choices: string[] = [];
    for (const type of parameter.type.types) {
      if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Error('unsupported route parameter union');
      choices.push(type.literal.text);
    }
    variants = variants.flatMap(value => choices.map(choice => value.replaceAll(match[0], choice)));
    if (variants.length > 32) throw new Error('too many concrete route variants');
  }
  return variants;
}

export function extractClientCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const sinResolver: string[] = [];
  const llamada = /(?<![A-Za-z0-9_$.])(?:this\.)?request\s*[<(]/g;
  for (let hallazgo = llamada.exec(source); hallazgo; hallazgo = llamada.exec(source)) {
    const index = hallazgo.index;
    if (/\b(?:function|async|private|public|protected|static|const|let)\s*$/.test(source.slice(Math.max(0, index - 24), index))) continue;
    const openParen = source.indexOf('(', index + hallazgo[0].length - 1);
    if (openParen === -1) break;
    const args = callArguments(source, openParen);
    const pathMatch = /^\s*[`'"]([^`'"]*)[`'"]/.exec(args);
    let ruta = pathMatch?.[1];
    const trailingCall = ruta === undefined ? undefined : /\$\{([^{}]*\([^{}]*\))\}$/.exec(ruta);
    if (trailingCall?.[1] !== undefined && !ruta?.slice(0, -trailingCall[0].length).includes('?')
      && !/^(?:encodeURIComponent|String)\(/.test(trailingCall[1])) {
      const query = querySuffixBefore(source, index, trailingCall[1]);
      ruta = query === undefined ? undefined : ruta?.replace(trailingCall[0], query);
    }
    if (ruta?.startsWith('${')) {
      const leading = /^\$\{([^}]+)\}([\s\S]*)$/.exec(ruta);
      const prefix = leading?.[1] === undefined ? undefined : helperRouteBefore(source, index, leading[1]);
      ruta = prefix === undefined ? undefined : `${prefix}${leading?.[2] ?? ''}`;
    }
    if (ruta === undefined) {
      const primerArgumento = requestRouteArgument(source, index) ?? '';
      ruta = helperRouteBefore(source, index, primerArgumento);
      const identificador = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(primerArgumento)?.[1];
      if (ruta === undefined) {
        ruta = identificador === undefined ? undefined : rutaDeclaradaAntes(source, index, identificador);
        if (ruta === undefined) {
          if (identificador !== undefined && esParametroDeLaFuncion(source, index, identificador)) continue;
          sinResolver.push(args.slice(0, 60).replace(/\s+/g, ' '));
          continue;
        }
      }
    }
    if (!ruta.startsWith('/v3/')) continue;
    const methodMatch = /method:\s*'([A-Za-z]+)'/.exec(args);
    const method = (methodMatch?.[1] ?? 'GET').toUpperCase();
    if (!isHttpMethod(method)) throw new Error(`unsupported HTTP method in client.ts: ${method}`);
    for (const path of concreteRouteVariants(source, index, ruta)) calls.push({ method, path: concreteSegments(path) });
  }
  if (sinResolver.length > 0) {
    throw new Error(
      'el extractor no supo sacar la ruta de estas llamadas de client.ts, así que quedarían FUERA '
      + `de la comprobación sin que nadie se entere: ${sinResolver.join(' | ')}`
    );
  }
  return calls;
}

