/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cc, Ci, Cu} = require("chrome");
let protocol = require("devtools/server/protocol");
let {method, RetVal} = protocol;
const { Promise: promise } = Cu.import("resource://gre/modules/Promise.jsm", {});
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

/**
 * A global actor that returns memory usage data from about:memory.
 */
let AboutMemoryActor = protocol.ActorClass({
  typeName: "aboutMemory",

  initialize: function(conn) {
    protocol.Actor.prototype.initialize.call(this, conn);
    this._dumper = Cc["@mozilla.org/memory-info-dumper;1"]
                     .getService(Ci.nsIMemoryInfoDumper);
  },

  destroy: function() {
    this._dumper = null;
    protocol.Actor.prototype.destroy.call(this);
  },

  getReports: method(function() {
    let deferred = promise.defer();

    let file = Services.dirsvc.get("TmpD", Ci.nsIFile);
    file.append("remoteAboutMemory.json.gz");
    file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, parseInt("660", 8));
    function onDone() {
      OS.File.read(file.path)
        .then(function (bytes) {
          let data = String.fromCharCode.apply(null, bytes);
          deferred.resolve({data:data});
          file.remove(false);
        });
    }
    this._dumper.dumpMemoryReportsToNamedFile(file.path, onDone, null);

    return deferred.promise;
  }, {
    request: {},
    response: RetVal("json"),
  })
});

exports.AboutMemoryActor = AboutMemoryActor;

exports.AboutMemoryFront = protocol.FrontClass(AboutMemoryActor, {
  initialize: function(client, form) {
    protocol.Front.prototype.initialize.call(this, client, form);
    console.log("init", form);
    this.actorID = form.aboutMemoryActor;
    client.addActorPool(this);
    this.manage(this);
  },
  getReportFile: function() {
    return this.getReports().then(function (data) {
       let file = Services.dirsvc.get("TmpD", Ci.nsIFile);
       file.append("remoteAboutMemory.json.gz");
       file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, parseInt("660", 8));

       return OS.File.open(file.path, { write: true, truncate: true })
         .then((f) => {
           data = data.data;
           let buffer = new Uint8Array(data.length);
           for (let i = 0, l = data.length; i < l ; i++) {
             buffer[i] = data.charCodeAt(i);
           }
           return f.write(buffer)
            .then((written) => {
              return file;
           });
         });
     });
  }
});
