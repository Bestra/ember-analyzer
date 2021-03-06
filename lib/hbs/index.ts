import * as htmlBars from 'htmlbars/dist/cjs/htmlbars-syntax';
import * as path from 'path';
import * as fs from 'fs';
import * as ember from '../ember';
import Resolver from '../util/resolver';
import Registry from '../util/registry';
import EmberClass from '../ember/emberClass';
import {
  ModuleDefinition,
  ModuleName,
  FilePath,
  PropertyGraphNode
} from '../util/types';

import * as _ from 'lodash';
import { containsPosition, containsNode, findNodes } from './util';

type Position = htmlBars.Position;
type FilePosition = { filePath: FilePath; position: Position };
interface Dict<T> {
  [index: string]: T;
}

/**
 * Defineable things have a `definedAt`, the position of their definition in the rendering context,
 * and `invokedWith`, a possible list of positions where the value was passed into
 * the rendering context
 */
export interface Defineable {
  definedAt: FilePosition | null;
  invokedWith: FilePosition[];
}

export interface TemplateInvocation {
  /**
     * The location of the mustache in the handlebars template
     */
  invokedAt: {
    filePath: string;
    position: Position;
  };
  astNode: htmlBars.ASTNode;
  invokedAttr: (attrName: string) => string;
  /**
     * The module name of the invoked template, either for a component or partial. 
     * {{foo-bar}} will be "template:components/foo-bar",
     * {{partial "foo-bar"}} will be "templates:foo-bar" (the same as moduleName)
     */
  templateModule: ModuleName;
  /**
     * The module name of the invoked component/partial. {{foo-bar}} will be "component:foo-bar",
     * {{partial "foo-bar"}} will be "templates:foo-bar"
     */
  moduleName: ModuleName;
  /**
   * The name of the template module where the the invocation is actually written.
   */
  parentModule: ModuleName;
  isPartial: boolean;
  props: Dict<htmlBars.Param>;
}

class NullPosition implements Defineable {
  template: Template;
  position: Position;

  //TODO: make this take a node
  constructor(template, position) {
    this.template = template;
    this.position = position;
  }
  get definedAt() {
    return {
      filePath: this.template.filePath,
      position: this.position
    };
  }

  get invokedWith() {
    return [];
  }
}

class TemplateMember<T> implements Defineable {
  containingTemplate: Template;
  astNode: T;
  registry: Registry;
  resolver: Resolver;

  constructor(template: Template, node: T) {
    this.containingTemplate = template;
    this.astNode = node;
    this.registry = this.containingTemplate.registry;
    this.resolver = this.registry.resolver;
  }

  get definedAt(): FilePosition | null {
    return null;
  }

  get invokedWith() {
    return [];
  }
}

/**
 * A mustache is anything inside {{}}
 */
export class Mustache extends TemplateMember<htmlBars.MustacheStatement> {
  /**
     * the path the mustache is called with;
     * for {{foo-bar}} the pathString is "foo-bar"
     */
  get pathString() {
    return this.astNode.path.original;
  }

  get attrs() {
    let pairs = this.astNode.hash.pairs;
    return _.map(pairs, 'key');
  }

  get params() {
    return this.astNode.params;
  }
  get definedAt(): FilePosition | null {
    return null;
  }
}

/**
 * {{partial "foo"}}
 */
export class Partial extends Mustache implements TemplateInvocation {
  get templateModule() {
    return <ModuleName>('template:' + this.templatePath);
  }
  get isPartial() {
    return true;
  }
  get parentModule() {
    return this.containingTemplate.moduleName;
  }
  get moduleName() {
    return this.templateModule;
  }

  get templatePath() {
    let partialPath = this.params[0] as htmlBars.StringLiteral;
    return partialPath.original;
  }

  get templateFilePath() {
    let m = this.registry.lookup(this.templateModule);
    return m && m.filePath;
  }

  get props() {
    return {};
  }

  get invokedAt() {
    return {
      filePath: this.registry.lookup(this.containingTemplate.moduleName)
        .filePath,
      position: this.astNode.loc.start
    };
  }

  invokedAttr(s) {
    return '';
  }

  get definedAt() {
    let filePath = this.templateFilePath;
    return {
      filePath,
      position: { line: 0, column: 0 }
    };
  }
}

/**
 * {{#my-block as |param|}}
 * 
 * {{/my-block}}
 */
export class Block extends Mustache {
  astNode: htmlBars.BlockStatement;

  get blockParams() {
    return this.astNode.program.blockParams;
  }

  blockParamDefinition(_index): FilePosition {
    return {
      filePath: this.containingTemplate.filePath,
      position: this.astNode.loc.start
    };
  }
}

export class ComponentInvocation extends Block implements TemplateInvocation {
  /**
   * The module name of the component being invoked by this block
   * {{foo-bar}} would be 'template:components/foo-bar'
   */
  get templateModule() {
    return this.resolver.componentTemplate(this.pathString);
  }

  get templateFilePath() {
    let m = this.registry.lookup(this.templateModule);
    return m && m.filePath;
  }

  get props() {
    let pairs = _.map(this.astNode.hash.pairs, p => {
      return [p.key, p.value];
    });
    return (_.fromPairs(pairs) as any) as Dict<htmlBars.Param>;
  }

  get isPartial() {
    return false;
  }
  get parentModule() {
    return this.containingTemplate.moduleName;
  }

  get moduleName() {
    return <ModuleName>`component:${this.pathString}`;
  }

  get component() {
    return this.registry.lookup(this.moduleName);
  }

  get invokedAt() {
    return {
      filePath: this.registry.lookup(this.containingTemplate.moduleName)
        .filePath,
      position: this.astNode.loc.start
    };
  }

  invokedAttr(attrName: string): string {
    let printedAttr = htmlBars.print(this.props[attrName]);
    if (printedAttr) {
      return `${attrName}=${printedAttr}`;
    } else {
      return `(${attrName} not provided)`;
    }
  }

  get definedAt() {
    let filePath =
      this.templateFilePath || this.registry.lookup(this.moduleName).filePath;
    return {
      filePath,
      position: { line: 0, column: 0 }
    };
  }

  blockParamDefinition(index): FilePosition {
    let def = this.registry.lookup(this.templateModule) as Template;
    let position = def.getYieldPosition(index);
    return {
      filePath: this.templateFilePath,
      position: position
    };
  }
}

/**
 * For now this only accounts for actions defined by
 * string literals, not bound paths
 */
export class Action extends TemplateMember<htmlBars.Callable> {
  get definedAt() {
    let contextModule = this.resolver.templateContext(
      this.containingTemplate.moduleName
    );

    let context = this.registry.lookup(contextModule) as ember.EmberClass;
    console.log(
      `looking up ${this.name} action from ${_.keys(context.actions)}`
    );
    let action = context.actions[this.name];

    return {
      filePath: action.parentClass.filePath,
      position: action.position
    };
  }

  get name() {
    let name = this.astNode.params[0] as htmlBars.StringLiteral;
    return name.original;
  }
}

export class PropertyInvocation implements PropertyGraphNode {
  invocation: TemplateInvocation;
  /**
   * The name of the property being set by the invocation
   * For {{foo-bar baz="buzz"}}, 'key' would be 'baz'
   */
  key: string;
  value;
  nodeType: 'propertyInvocation' = 'propertyInvocation';
  get nodeModuleName() {
    return this.invocation.parentModule;
  }
  get name() {
    return this.key;
  }

  get position() {
    let p = this.invocation.invokedAt.position;
    return {
      line: p.line,
      column: p.column
    };
  }

  constructor(i: TemplateInvocation, key: string, value: any) {
    this.invocation = i;
    this.key = key;
    this.value = value;
  }
  get propertyGraphKey() {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.invocation.invokedAt.position.line,
      this.invocation.invokedAt.position.column
    ].join('$');
  }
  get dotGraphKey() {
    return [
      this.nodeType,
      this.key,
      this.invocation.invokedAt.position.line,
      this.invocation.invokedAt.position.column
    ].join('$');
  }
}
export class Path extends TemplateMember<htmlBars.PathExpression>
  implements PropertyGraphNode {
  get root() {
    return this.astNode.parts[0];
  }
  astNode: htmlBars.PathExpression;
  nodeType: 'boundProperty' = 'boundProperty';
  get name() {
    return this.root;
  }
  get position() {
    let p = this.astNode.loc.start;
    return {
      line: p.line,
      column: p.column
    };
  }
  get propertyGraphKey(): string {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.astNode.loc.start.line,
      this.astNode.loc.start.column
    ].join('$');
  }
  get dotGraphKey(): string {
    return `${this.nodeType}$${this.root}$${this.astNode.loc.start.line}$${this
      .astNode.loc.start.column}`;
  }
  get nodeModuleName() {
    return this.containingTemplate.moduleName;
  }

  get invokedWith() {
    return [];
  }

  get definedAt() {
    let contextModule = this.resolver.templateContext(
      this.containingTemplate.moduleName
    );

    let context = this.registry.lookup(contextModule) as ember.EmberClass;
    let prop = context.properties[this.root];
    if (prop) {
      return {
        filePath: prop.parentClass.filePath,
        position: prop.position
      };
    } else {
      return null;
    }
  }
}

/**
 * BlockParams are those yielded by a block helper.
 * {{#each foos as |foo|}} <-- foo is a block param
 */
export class BlockParam extends TemplateMember<htmlBars.BlockStatement>
  implements PropertyGraphNode {
  index: number;
  name: string;
  block: Block;
  nodeType: 'blockParam' = 'blockParam';
  get nodeModuleName() {
    return this.containingTemplate.moduleName;
  }
  constructor(template: Template, name: string, block: Block, index: number) {
    super(template, block.astNode);
    this.index = index;
    this.name = name;
    this.block = block;
  }

  get definedAt() {
    return this.block.blockParamDefinition(this.index);
  }

  get position() {
    let p = this.astNode.loc.start;
    return {
      line: p.line,
      column: p.column
    };
  }

  get propertyGraphKey(): string {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.position.line,
      this.position.column
    ].join('$');
  }
  get dotGraphKey(): string {
    return `${this.nodeType}$${this.name}$${this.astNode.loc.start.line}$${this
      .astNode.loc.start.column}`;
  }
}

function findContainingComponent(template: Template, pathExpr) {
  const hasPath = n => n.astNode.path === pathExpr;
  return _.find(template.components, hasPath);
}

/**
 * Finds the first node of a given type that contains the given position
 * @param ast 
 * @param position 
 * @param type 
 */
let nodeContainingPosition = (ast, position, type) => {
  return _.first(findNodes<any>(ast, type, n => containsPosition(n, position)));
};

class NoContext {
  definition;
  moduleName;
  constructor(moduleName) {
    this.moduleName = moduleName;
  }
}

/**
 * Template is the represenation of a .hbs file.
 * Every template has a rendering context, even if it's an implicit one.
 */
export class Template implements ModuleDefinition {
  moduleName: ModuleName;
  filePath: FilePath;
  registry: Registry;
  src: string;
  get renderingContext() {
    return (
      this.registry.lookup(
        this.registry.resolver.templateContext(this.moduleName)
      ) || new NoContext(this.moduleName)
    );
  }

  propertyGraphKey;

  constructor(
    moduleName: ModuleName,
    filePath: FilePath,
    registry: Registry,
    src: string
  ) {
    this.moduleName = moduleName;
    this.filePath = filePath;
    this.registry = registry;
    this.src = src;
  }

  _astNode: htmlBars.Program;
  get astNode() {
    if (this._astNode) {
      return this._astNode;
    }
    this._astNode = htmlBars.parse(this.src);
    return this._astNode;
  }

  _cache: {
    SubExpression: htmlBars.SubExpression[];
    MustacheStatement: htmlBars.MustacheStatement[];
    ElementModifierStatement: htmlBars.ElementModifierStatement[];
    BlockStatement: htmlBars.BlockStatement[];
    StringLiteral: htmlBars.StringLiteral[];
    PathExpression: htmlBars.PathExpression[];
    All: htmlBars.ASTNode[];
  };

  /**
   * Different AST node types are cached for quicker access later
   */
  get cachedNodes() {
    if (!!this._cache) {
      return this._cache;
    }

    let cachedNodeTypes = [
      'SubExpression',
      'MustacheStatement',
      'ElementModifierStatement',
      'BlockStatement',
      'StringLiteral',
      'PathExpression'
    ];

    this._cache = {
      SubExpression: [],
      MustacheStatement: [],
      ElementModifierStatement: [],
      BlockStatement: [],
      StringLiteral: [],
      PathExpression: [],
      All: []
    };

    let nodes = findNodes<htmlBars.ASTNode>(
      this.astNode,
      'All',
      k => !!this._cache[k.type]
    );

    nodes.forEach(n => {
      this._cache[n.type].push(n);
      this._cache['All'].push(n);
    });

    return this._cache;
  }

  /**
     * A 'prop' is the root value of any path present in the template.
     * {{foo.bar}} and {{foo.baz}} are both paths with a root of 'foo',
     * and the prop will serve as a bucket for both of them.
     * foo: ['foo.bar', 'foo.baz']
     */
  get props(): Dict<string[]> {
    return this.boundPaths.reduce((accum, p) => {
      if (!accum[p.root]) {
        accum[p.root] = [];
      }

      accum[p.root].push(p.astNode.original);
      return accum;
    }, {} as Dict<string[]>);
  }

  get boundPaths(): Path[] {
    let isHelper = n => {
      if (
        n.type === 'SubExpression' ||
        n.type === 'MustacheStatement' ||
        n.type === 'ElementModifierStatement' ||
        n.type === 'BlockStatement'
      ) {
        return n.params.length > 0 || n.hash.pairs.length > 0;
      } else {
        return false;
      }
    };
    let helpers = this.cachedNodes['All'].filter(
      isHelper
    ) as htmlBars.Callable[];

    let allPaths = this.cachedNodes['PathExpression'];

    let SPECIAL_PATH_NAMES = ['yield', 'outlet'];
    return _(allPaths)
      .reject(p => !!findContainingComponent(this, p))
      .reject(p => !!_.find(helpers, h => h.path === p))
      .reject(p => _.includes(SPECIAL_PATH_NAMES, p.original))
      .map(p => new Path(this, p))
      .value();
  }

  get partials() {
    return this.cachedNodes['MustacheStatement']
      .filter(n => n.path.original == 'partial')
      .map(n => new Partial(this, n));
  }

  get actions() {
    let isActionExpr = n => {
      if (
        n.type === 'SubExpression' ||
        n.type === 'MustacheStatement' ||
        n.type === 'ElementModifierStatement'
      ) {
        return (
          n.path.original === 'action' && n.params[0].type === 'StringLiteral'
        );
      } else {
        return false;
      }
    };
    return (this.cachedNodes['All'].filter(
      isActionExpr
    ) as any[]).reduce((accum, node) => {
      accum[node.params[0].original] = true;
      return accum;
    }, {});
  }

  get invocations(): TemplateInvocation[] {
    let arr: TemplateInvocation[] = [];
    return arr.concat(this.partials, this.components);
  }
  get components() {
    let blockComponents = _.filter(this.blocks, block => {
      return block instanceof ComponentInvocation;
    }) as ComponentInvocation[];

    let mustacheComponents = this.cachedNodes['MustacheStatement']
      .filter(n => !!this.registry.findComponent(n.path.original))
      .map(n => new ComponentInvocation(this, n));

    return blockComponents.concat(mustacheComponents);
  }

  get blocks() {
    return this.cachedNodes['BlockStatement'].map(node => {
      if (!!this.registry.findComponent(node.path.original)) {
        return new ComponentInvocation(this, node);
      } else {
        return new Block(this, node);
      }
    });
  }

  getYield(index) {
    let yieldNode = this.cachedNodes['MustacheStatement'].filter(
      node => node.path.original === 'yield'
    )[0];

    return yieldNode.params[index];
  }

  getYieldPosition(index) {
    return this.getYield(index).loc.start;
  }

  blockParamFromPath(path: Path): BlockParam | null {
    let foundBlock = _.find(this.blocks, block => {
      let contains = containsPosition(block.astNode, path.astNode.loc.start);
      return contains && block.blockParams.indexOf(path.root) > -1;
    });

    if (foundBlock) {
      let b = new BlockParam(
        this,
        path.root,
        foundBlock,
        foundBlock.blockParams.indexOf(path.root)
      );
      return b;
    } else {
      return null;
    }
  }

  /**
 * Returns a PropertyGraph node for a given position.
 * Right now this only works for bound properties and block params
 * TODO: get working for invoked attributes
 * @param position 
 */
  parsePropertyGraphNode(position: Position): PropertyGraphNode | null {
    console.log('looking up position ', position);
    let findContainer = _.partial(
      nodeContainingPosition,
      this.astNode,
      position
    );

    let pathExpr = findContainer('PathExpression');
    if (pathExpr) {
      let foundPath = new Path(this, pathExpr);
      return this.blockParamFromPath(foundPath) || foundPath;
    } else {
      return null;
    }
  }
  parsePosition(position: Position): Defineable {
    console.log('looking up position ', position);
    let findContainer = _.partial(
      nodeContainingPosition,
      this.astNode,
      position
    );

    let pathExpr = findContainer('PathExpression');
    let stringLiteral = findContainer('StringLiteral');
    // find mustaches and subexpressions whose path is 'action' and have this
    // string literal as the first param
    let isActionExpr = n => {
      if (
        n.type === 'SubExpression' ||
        n.type === 'MustacheStatement' ||
        n.type === 'ElementModifierStatement'
      ) {
        return n.path.original === 'action' && n.params[0] === stringLiteral;
      } else {
        return false;
      }
    };
    let actionExpr = this.cachedNodes['All'].filter(isActionExpr)[0] as any;
    if (actionExpr) {
      return new Action(this, actionExpr);
    } else if (pathExpr) {
      let component = findContainingComponent(this, pathExpr);
      let foundPath = new Path(this, pathExpr);
      return this.blockParamFromPath(foundPath) || component || foundPath;
    } else {
      // eventually this should include actions, etc.
      // for now if it's not a path we don't care
      return new NullPosition(this, position);
    }
  }
}
