import * as path from 'path';
import * as recast from 'recast';
import * as fs from 'fs';
import * as _ from 'lodash';
import { parseJs } from '../util/parser';

import * as AST from '../ember/ast';
import Registry from '../util/registry';
import {
  ModuleDefinition,
  ModuleName,
  FilePath,
  PropertyGraphNode
} from '../util/types';
type Prop = { [index: string]: AST.Position };
interface Dict<T> {
  [index: string]: T;
}

export class PropertyGet implements PropertyGraphNode {
  parentClass: EmberClass;
  position: AST.Position;
  location: AST.Location;
  name: string;
  nodeType: 'propertyGet' = 'propertyGet';
  get nodeModuleName() {
    return this.parentClass.moduleName;
  }
  get propertyGraphKey() {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.position.line,
      this.position.column
    ].join('$');
  }
  get dotGraphKey() {
    return `${this.nodeType}$${this.name}$${this.position.line}$${this.position
      .column}`;
  }
}

export class PropertySet implements PropertyGraphNode {
  parentClass: EmberClass;
  position: AST.Position;
  name: string;
  location: AST.Location;
  nodeType: 'propertySet' = 'propertySet';
  get nodeModuleName() {
    return this.parentClass.moduleName;
  }
  get propertyGraphKey() {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.position.line,
      this.position.column
    ].join('$');
  }
  get dotGraphKey() {
    return `${this.nodeType}$${this.name}$${this.position.line}$${this.position
      .column}`;
  }
}

export class PrototypeProperty implements PropertyGraphNode {
  parentClass: EmberClass;
  position: AST.Position;
  location: AST.Location;
  name: string;
  consumedKeys: string[];
  isImplicit: boolean;
  nodeType: 'prototypeProperty' = 'prototypeProperty';
  get nodeModuleName() {
    return this.parentClass.moduleName;
  }
  get dotGraphKey() {
    return `${this.nodeType}$${this.name}$${this.position.line}$${this.position
      .column}`;
  }

  constructor(astNode, parentClass: EmberClass, isImplicit = false) {
    let { loc: { start: { line, column } }, key: { name } } = astNode;
    this.name = name;
    this.position = { line, column };
    this.location = astNode.loc;
    this.parentClass = parentClass;
    this.isImplicit = isImplicit;
    this.consumedKeys = AST.findConsumedKeys(astNode);
  }
  get propertyGraphKey() {
    return [
      this.nodeType,
      this.nodeModuleName,
      this.name,
      this.position.line,
      this.position.column
    ].join('$');
  }
}

export class ImplicitPrototypeProperty implements PropertyGraphNode {
  name: string;
  nodeType: 'prototypeProperty' = 'prototypeProperty';
  nodeModuleName: ModuleName;
  isImplicit = true;

  constructor(name, nodeModuleName) {
    this.name = name;
    this.nodeModuleName = nodeModuleName;
  }
  get propertyGraphKey() {
    return [this.nodeType, this.nodeModuleName, this.name].join('$');
  }
  get dotGraphKey() {
    return `implicitPrototypeProperty$${this.name}`;
  }

  get position() {
    return {line: 0, column: 0}
  }
}

class Action extends PrototypeProperty {}

function emptyDict<T>(): Dict<T> {
  return {};
}

export default class EmberClass implements ModuleDefinition {
  moduleName: ModuleName;
  filePath: FilePath;
  registry: Registry;
  src: string;

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

  _ast: any;
  get ast() {
    if (this._ast) {
      return this._ast;
    }

    this._ast = parseJs(this.src);
    return this._ast;
  }

  extractProps(ast, parent: EmberClass) {
    let dict: Dict<PrototypeProperty> = {};

    AST.defaultExportProps(ast)
      .filter(({ value, key }) => {
        return value.type !== 'FunctionExpression' && key.name !== 'actions';
      })
      .forEach(k => {
        let newProp = new PrototypeProperty(k, parent);
        dict[newProp.name] = newProp;
      });

    return dict;
  }

  extractActions(ast, parent: EmberClass) {
    let dict: Dict<Action> = {};
    let actionsHash: any = _.find(AST.defaultExportProps(ast), {
      key: { name: 'actions', type: 'Identifier' }
    });
    if (actionsHash) {
      actionsHash.value.properties.forEach(p => {
        let a = new Action(p, parent);
        dict[a.name] = a;
      });
      return dict;
    }
  }

  extractMixins(ast): EmberClass[] {
    let mixins = _(AST.extractMixinIdentifiers(ast))
      .map(name => {
        let aPath = AST.findImportPathForIdentifier(ast, name);
        if (!aPath || !this.registry.lookupByAppPath(aPath)) {
          console.log(
            'Unable to find module for ',
            name,
            ' looking in ',
            aPath
          );
          return new EmptyEmberClass('component:ember', this.registry);
        } else {
          return this.registry.lookupByAppPath(aPath) as EmberClass;
        }
      })
      .value();

    return mixins;
  }

  extractSuperClass(ast): EmberClass {
    let name = AST.superClassIdentifier(ast);
    let emberNames = [
      'Ember',
      'Component',
      'Route',
      'Controller',
      'View',
      'Mixin'
    ];
    if (_.indexOf(emberNames, name) > -1 || !name) {
      return new EmptyEmberClass('component:ember', this.registry); //TODO make this a null object
    }
    let importPath = AST.findImportPathForIdentifier(ast, name);

    if (!importPath || !this.registry.lookupByAppPath(importPath)) {
      console.log(
        'Unable to find module for ',
        name,
        ' looking in ',
        importPath
      );

      return new EmptyEmberClass('component:ember', this.registry);
    } else {
      return this.registry.lookupByAppPath(importPath) as EmberClass;
    }
  }

  get superClass(): EmberClass | null {
    return this.extractSuperClass(this.ast);
  }
  get mixins(): EmberClass[] {
    return this.extractMixins(this.ast);
  }

  get properties(): Dict<PrototypeProperty> {
    let superProps = this.superClass ? this.superClass.properties : {};
    let mixinProps = this.mixins.map(m => m.properties);
    // console.log("super props are ", _.keys(superProps))
    let localProps = this.extractProps(this.ast, this);
    let emptyDict: Dict<PrototypeProperty> = {};

    return _.assign<Dict<PrototypeProperty>>(
      {},
      superProps,
      ...mixinProps,
      localProps
    );
  }

  get propertyGets(): PropertyGet[] {
    return AST.findThisGets(this.ast, 'get').map(n => {
      let p = new PropertyGet();
      let firstArg = n.arguments[0] as any;
      p.location = n.loc!;
      p.name = firstArg.value;
      p.parentClass = this;
      let { line, column } = n.loc!.start;
      p.position = { line, column };
      return p;
    });
  }

  get propertySets(): PropertySet[] {
    return AST.findThisGets(this.ast, 'set').map(n => {
      let p = new PropertySet();
      let firstArg = n.arguments[0] as any;
      p.name = firstArg.value;
      p.location = n.loc!;
      p.parentClass = this;
      let { line, column } = n.loc!.start;
      p.position = { line, column };
      return p;
    });
  }

  get props(): PrototypeProperty[] {
    return _.values(this.extractProps(this.ast, this));
  }

  get actions(): Dict<Action> {
    let superActions = this.superClass ? this.superClass.actions : {};
    let mixinActions = this.mixins.map(m => m.actions);

    // console.log("super actions are ", _.keys(superActions))
    let localActions = this.extractActions(this.ast, this);
    return _.assign<Dict<Action>>(
      {},
      superActions,
      ...mixinActions,
      localActions
    );
  }

  parsePropertyGraphNode(position: AST.Position): PropertyGraphNode | null {
    //for now look through the gets and sets, then look at the props
    return (
      _.find(this.propertyGets, p =>
        AST.containsPosition(p.location, position)
      ) ||
      _.find(this.propertySets, p =>
        AST.containsPosition(p.location, position)
      ) ||
      _.find(this.props, p =>
        AST.containsPosition(p.location, position)
      ) ||
      null
    );
  }
}

export class EmptyEmberClass extends EmberClass {
  get superClass() {
    return null;
  }

  get mixins() {
    return [];
  }

  constructor(moduleName, registry) {
    super(moduleName, <FilePath>'NO FILE', registry, '');
  }

  get properties() {
    return emptyDict<PrototypeProperty>();
  }

  get actions() {
    return emptyDict<Action>();
  }
}
