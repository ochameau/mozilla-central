/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const protocol = require("devtools/server/protocol");
const {method, RetVal} = protocol;
const {MemoryProfiler} = require("devtools/memory-profiler");

/**
 * Creates a MemoryActor. MemoryActor provides remote access to the
 * javascript object being kept alive.
 *
 * MemoryActor.onGetProfile returns a JavaScript object with data
 * generated out of CC graph analysis. It has the following
 * format:
 *
 * TBD
 *
 */
let MemoryActor = protocol.ActorClass({
  typeName: "memoryAlex",

  initialize: function(conn, tabActor) {
    console.log("actor init")
    protocol.Actor.prototype.initialize.call(this, conn);
    this.tabActor = tabActor;
    this._profiler = new MemoryProfiler(tabActor.window);
  },

  destroy: function() {
    protocol.Actor.prototype.destroy.call(this);
  },

  _started: false,

  start: method(function(aRequest) {
    console.log("actor start");
    if (this._started)
      return {};
    this._started = true;
    this._profiler.start();
    return {};
  }, {request: {}, response: {}}),

  stop: method(function() {
    if (!this._started) {
      return;
    }
    this._profiler.stop();
    this._started = false;
  }, {request: {}, response: {}}),

  getProfile: method(function () {
    console.log("actor profile");
    return this._profiler
               .snapshot()
               .then((profile) => {
                let v = { profile: profile };
                console.log("resolve", typeof v, v);
                return v;
               });
  }, {request: {}, response: { value: RetVal("json")}}),
});

let MemoryFront = exports.MemoryFront = protocol.FrontClass(MemoryActor, {
  initialize: function(client, form) {
    protocol.Front.prototype.initialize.call(this, client);
    this.actorID = form.memoryAlexActor;
    client.addActorPool(this);
    this.manage(this);
  },

});

