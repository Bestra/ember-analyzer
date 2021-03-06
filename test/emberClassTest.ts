let td = require("testdouble");
import * as _ from "lodash";
import * as assert from "assert";
import Registry from "../lib/util/registry";
import Resolver from "../lib/util/resolver";
import EmberClass from "../lib/ember/emberClass";
import { ModuleName, FilePath } from "../lib/util/types";
afterEach(function() {
  td.reset();
});

describe("EmberClass", function() {
  var registry, subject;
  beforeEach(function() {
    registry = td.object(new Registry(new Resolver()));
  });

  describe("component is an Ember subclass", function() {
    beforeEach(function() {
      let childSrc = `
        import Ember from 'ember';
        export default Ember.Object.extend({
          childProp: Ember.inject.service()
        });
        `;

      subject = new EmberClass(
        <ModuleName>"component:child",
        <FilePath>"testFile",
        registry,
        childSrc
      );
    });

    it("properties returns a dictionary of props", function() {
      assert.ok(subject.properties["childProp"]);
    });

    describe("consumed properties", function() {
      beforeEach(function() {
        let childSrc = `
        import Ember from 'ember';
        export default Ember.Object.extend({
          childProp: Ember.computed(function() {
            this.get('foo');
            this.get('bar');
          })
        });
        `;
        subject = new EmberClass(
          <ModuleName>"component:child",
          <FilePath>"testFile",
          registry,
          childSrc
        );
      });

      it("properties contains the list of consumed keys", function() {
        let keys = subject.properties["childProp"].consumedKeys;
        assert.ok(_.includes(keys, "foo"));
        assert.ok(_.includes(keys, "bar"));
      });
    });

    it("superclass is the default ember class", function() {
      assert.equal(subject.superClass.moduleName, "component:ember");
    });
  });
  describe("component is some other subclass", function() {
    beforeEach(function() {
      let childSrc = `
          import Ember from 'ember';
          import ParentComponent from 'my-app/components/parent';
          export default ParentComponent.extend({
            childProp: Ember.inject.service()
          });
          `;
      subject = new EmberClass(
        <ModuleName>"component:child",
        <FilePath>"testFile",
        registry,
        childSrc
      );
      let parentSrc = `export default Ember.Component.extend({parentProp: "foo"})`;
      td.when(registry.lookupByAppPath("my-app/components/parent")).thenReturn({
        definition: new EmberClass(
          <ModuleName>"component:parent",
          <FilePath>"parentPath",
          registry,
          parentSrc
        )
      });
    });

    it("properties returns a dictionary of props", function() {
      assert.ok(subject.properties["childProp"]);
      assert.ok(subject.properties["parentProp"]);
    });
  });
});
