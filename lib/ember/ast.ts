import * as recast from 'recast';
import * as _ from 'lodash';
import * as ESTree from 'estree';

export interface Position { line: number; column: number }
export interface Location { start: Position; end: Position }
type Prop = { [index: string]: Position };
interface Dict<T> {
  [index: string]: T;
}
function startsWithin(
  line: number,
  column: number,
  container: { line: number; column: number }
) {
  // console.log("check start - ",[line, column, container.line, container.column].join(':'))
  if (line < container.line) {
    return false;
  } // completely excluded
  if (line > container.line) {
    return true;
  } // completely included
  if (line === container.line) {
    if (column >= container.column) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

function endsWithin(line, column, container: Position) {
  // console.log("check end - ",[line, column, container.line, container.column].join(':'))
  if (line > container.line) {
    return false;
  } // completely excluded
  if (line < container.line) {
    return true;
  } // completely included
  if (line === container.line) {
    if (column <= container.column) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

export function containsPosition(loc: Location, { line, column }) {
  if (!loc) {
    return false;
  }
  return (
    startsWithin(line, column, loc.start) && endsWithin(line, column, loc.end)
  );
}

export function containsNode(parent: any, child: any) {
  return (
    containsPosition(parent, child.loc.start) &&
    containsPosition(parent, child.loc.end)
  );
}

export interface ObjectProperty extends ESTree.Property {
  key: ESTree.Identifier;
}

/**
 * Finds `this.get` and `this.set`
 * @param astNode 
 * @param s 
 */
export function findThisGets(astNode, s: 'get' | 'set') {
  let isGet = _.matches({
    callee: {
      object: { type: 'ThisExpression' },
      property: { name: s }
    }
  });
  let nodes: ESTree.CallExpression[] = [];
  recast.visit(astNode, {
    visitCallExpression(path) {
      let getter = path.node;
      if (isGet(getter)) {
        nodes.push(getter);
      }
      this.traverse(path);
    }
  });
  return nodes;
}

export function findConsumedKeys(astNode): string[] {
  let isGet = _.matches({
    callee: {
      object: { type: 'ThisExpression' },
      property: { name: 'get' }
    }
  });
  let keys: string[] = [];
  recast.visit(astNode, {
    visitCallExpression(path) {
      let getter = path.node;
      if (isGet(getter)) {
        keys.push(getter.arguments[0].value);
      }
      this.traverse(path);
    }
  });
  return keys;
}

export function rootIdentifier(memberExpr: any) {
  let findRoot = aNode => {
    if (aNode.type === 'Identifier') {
      return aNode.name;
    } else if (aNode.object.type === 'MemberExpression') {
      return findRoot(aNode.object);
    } else {
      return null;
    }
  };
  return findRoot(memberExpr);
}

export function superClassIdentifier(ast) {
  let name: string | null = null;
  recast.visit(ast, {
    visitExportDefaultDeclaration: function({ node: { declaration } }) {
      if (declaration.callee) {
        let typeExpr = declaration.callee.object;
        name = rootIdentifier(typeExpr);
      } else {
        name = null;
      }
      return false;
    }
  });
  return name;
}

export function extractMixinIdentifiers(ast): string[] {
  let mixinArgs: any[] = [];

  recast.visit(ast, {
    visitExportDefaultDeclaration: function({ node: { declaration } }) {
      let args: any[] = declaration.arguments;
      if (args && args.length > 1) {
        mixinArgs = args.slice(0, -1);
      } else {
        mixinArgs = [];
      }
      return false;
    }
  });

  return _(mixinArgs)
    .filter({ type: 'Identifier' })
    .map<string>('name')
    .value();
}

export function findImportPathForIdentifier(ast, name: string): string | null {
  let importPath: string | null = null;
  recast.visit(ast, {
    //for some reason the nodePath here conforms to a different spec than the other
    //paths, hence the funny business
    visitImportDefaultSpecifier: function(path) {
      if (
        path.value.local.type === 'Identifier' &&
        path.value.local.name === name
      ) {
        importPath = path.parentPath.node.source.value;
      }
      return false;
    }
  });
  return importPath;
}

export function defaultExportProps(ast) {
  let directProps: ObjectProperty[] = [];
  recast.visit(ast, {
    visitExportDefaultDeclaration: function({ node: { declaration } }) {
      let args = declaration.arguments;
      if (args && args.length) {
        directProps = _.last<any>(args).properties;
      }
      return false;
    }
  });
  return directProps || [];
}
