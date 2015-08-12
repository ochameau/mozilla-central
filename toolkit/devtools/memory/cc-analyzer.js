const { Cc, Ci } = require("chrome");
const { setTimeout } = require("sdk/timers");

function CCAnalyzer(gc) {
  this.gcTrace = gc;
}

CCAnalyzer.prototype = {
  clear: function () {
    this.callback = null;
    this.processingCount = 0;
    this.graph = new Map();
    this.list = [];
    this.roots = [];
    this.garbage = [];
    this.edges = [];
    this.listener = null;
  },

  run: function (window, target, aCallback, sync) {
    this.clear();
    this.callback = aCallback;

    this.listener = Cc["@mozilla.org/cycle-collector-logger;1"].
      createInstance(Ci.nsICycleCollectorListener);

    this.listener.disableLog = true;
    this.listener.wantAfterProcessing = true;

    try {
      if (target) {
        this.listener.traceCompartment(target);
      } else {
        this.listener.traceCompartment(null);
      }
    } catch(e) {console.log("Unable to trace just a compartment.");}

    if (this.gcTrace)
      this.listener = this.listener.allTraces();

    this.runCC(window, 3, sync);
  },

  runCC: function (window, aCounter, sync) {
    let utils = window.QueryInterface(Ci.nsIInterfaceRequestor)
                      .getInterface(Ci.nsIDOMWindowUtils);

    if (aCounter > 1) {
      utils.garbageCollect();
      if (sync)
        this.runCC(window, aCounter -1, sync);
      else
        setTimeout(this.runCC.bind(this, window, aCounter - 1), 0);
    } else {
      utils.garbageCollect(this.listener);
      this.processLog();
    }
  },

  processLog: function (sync) {
    // Process entire heap step by step in 10K chunks
    for (let i = 0; i < 10000; i++) {
      if (!this.listener.processNext(this)) {
        try {
          this.callback();
        } catch(e) {
          console.exception(e);
        }
        return;
      }
    }

    // Next chunk on timeout.
    if (sync)
      this.processLog();
    else
      setTimeout(this.processLog.bind(this), 0);
  },

  noteRefCountedObject: function (aAddress, aRefCount, aObjectDescription) {
    let o = this.ensureObject(aAddress);
    o.address = aAddress;
    o.refcount = aRefCount;
    o.name = aObjectDescription;
  },

  noteGCedObject: function (aAddress, aMarked, aObjectDescription, aCompartmentAddr) {
    let o = this.ensureObject(aAddress);
    o.address = aAddress;
    o.gcmarked = aMarked;
    o.name = aObjectDescription;
    o.compartment = aCompartmentAddr;
    //if (aObjectDescription.match(/\{/))
    //dump("Desc: "+aObjectDescription+"\n");
  },

  noteEdge: function (aFromAddress, aToAddress, aEdgeName) {
    let fromObject = this.ensureObject(aFromAddress);
    let toObject = this.ensureObject(aToAddress);
    fromObject.edges[aEdgeName] = toObject;
    toObject.owners[aEdgeName] = fromObject;

    this.edges.push({
      name: aEdgeName,
      from: fromObject,
      to: toObject
    });
  },

  describeRoot: function (aAddress, aKnownEdges) {
    let o = this.ensureObject(aAddress);
    o.root = true;
    o.knownEdges = aKnownEdges;
    this.roots.push(o);
  },

  describeGarbage: function (aAddress) {
    let o = this.ensureObject(aAddress);
    o.garbage = true;
    this.garbage.push(o);
  },

  ensureObject: function (aAddress) {
    if (!this.graph.has(aAddress)) {
      let o = new CCObject(aAddress);
      this.list.push(o);
      this.graph.set(aAddress, o);
    }

    return this.graph.get(aAddress);
  },

  find: function (aText) {
    let result = [];
    for each (let o in this.graph) {
      if (!o.garbage && o.name.indexOf(aText) >= 0)
        result.push(o);
    }
    return result;
  }
};

function CCObject(aAddress) {
  this.name = "";
  this.address = null;
  this.key = aAddress;
  this.refcount = 0;
  this.gcmarked = false;
  this.root = false;
  this.garbage = false;
  this.knownEdges = 0;
  this.edges = {};
  this.owners = {};
}

exports.CCAnalyzer = CCAnalyzer;

