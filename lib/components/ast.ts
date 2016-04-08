
   export interface Loc {
        line: number;
        column: number;
    }

   export interface Node {
        type: string;
        start: number;
        end: number;
        loc: {
            start: Loc;
            end: Loc;
        }
    }
    
    export interface NodePath {
        node: Node;
        parent: NodePath;
        scope;
    }

    export interface Property extends Node {
        key: { name: "string" };
        value: { type: "string" };
    }