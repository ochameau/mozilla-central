const { components, Cu, Cc, Ci } = require("chrome");
const promise = require("promise");
const { CCAnalyzer } = require("./cc-analyzer");

function MemoryProfiler(context) {
  this._context = context;
  this._listener = Cc["@mozilla.org/cycle-collector-logger;1"]
                     .createInstance(Ci.nsICycleCollectorListener);
}

MemoryProfiler.prototype.start = function () {
  console.log("memory profiler start");
  this._listener.enableAllocationMetadata(this._context);
  this._listener.traceZone(this._context);
};

MemoryProfiler.prototype.stop = function () {
  this._listener.disableAllocationMetadata(this._context);
  this._listener.traceZone(null);
};

MemoryProfiler.prototype.snapshot = function () {
  console.log("memory profiler snapshot");
  let deferred = promise.defer();

  let analyzer = new CCAnalyzer(true);
  analyzer.run(this._context, function () {
    console.log("done");
    let parents = {}, unclassifieds = [], counts = {};
    for (let i in analyzer.graph) {
      let o = analyzer.graph[i];
      // Parse CycleCollectorJSRuntime string output
      let m = o.name.match(/JS ([^ ]+)( \((.+)\))?( parent:([^ ]+))?( (\{.+\}))?/);
      if (m) {
        let type = m[1];
        let description = m[3] || "";
        let addr = m[5];
        let allocationMetadata = m[7] ? JSON.parse(m[7]) : {};
        if (allocationMetadata) {
          let { file, line } = allocationMetadata;
          if (file) {
            if (!counts[file])
              counts[file] = {};
            if (!counts[file][line])
              counts[file][line] = 0;
            counts[file][line]++;
          }
        }
        let parent = analyzer.graph[addr];
        if (parent) {
          let child = {
            type: type,
            description: description,
            allocation: allocationMetadata
          };
          if (!parents[addr])
            parents[addr] = {name: parent.name, childs: []};
          parents[addr].childs.push(child);
          continue;
        }

      }
      unclassifieds.push(o.name);
    }
    deferred.resolve({ parents, unclassifieds, counts });
  });

  return deferred.promise;
};

MemoryProfiler.prototype.getDeadWrappers = function () {
  let deferred = promise.defer();

  let analyzer = new CCAnalyzer(true);
  analyzer.run(this._context, () => {
    let list = [];
    for (let i in analyzer.graph) {
      let o = analyzer.graph[i];
      for (let i = 0; i < o.edges.length; i++) {
        let e = o.edges[i];
        if (e.to.name.indexOf("JS Object (Proxy)") == 0) {
          list.push({obj: o.name, edge: e.name});
        }
      }
    }
    deferred.resolve(list);
  });

  return deferred.promise;
};

exports.MemoryProfiler = MemoryProfiler;



function lookForDeadWrappers(cx, analyzer, done) {
  let deads = [];
  for (let i in analyzer.graph) {
    let o = analyzer.graph[i];
    if (o.name == "JS Object (Proxy)") {
      if (jsapi.JS_IsDeadWrapper(jsapi.getPointerForAddress(o.address))) {
        deads.push(o);
      }
    }
  }
  done(deads);
}

function dumpSnapshot(cx, analyzer, done) {
  let newObjects = memapi.getSnapshotObjects();
  let objects = [];
  for each (let address in newObjects) {
    if (address in analyzer.graph)
      objects.push(analyzer.graph[address]);
    else
      console.log("Object freed since the snapshot??");
  }
  done(objects);
}

let magicObject = {};
let magicId = "magic-" + Math.random();
function setMagicObject() {
  // Set an attribute with a unique attribute name
  // so that we can easily identify our object array in the CC graph
  // by looking for an edge with same unique name
  magicObject[magicId] = memapi.getTrackedObjects().map(function (o) {
    // Temporary get strong references to objects,
    // in order to be able to have an edge to them.
    // (weakref object don't store edge to the target object)
    return o.get();
  });
}
function lookForMagicObject(cx, analyzer, done) {
  // Search for magic object by finding the edge
  // with the `magicId` name which is the attribute name
  // on magic object that refers to the `trackedObjects` array
  for (var i in analyzer.graph) {
    let o = analyzer.graph[i];
    if (o.name != "JS Object (Object)")
      continue;
    if (o.edges.some(function (e) {
      if (e.name == magicId) {
        let trackedObjects = e.to;
        // Eventually unwrap the array as it comes from another sandbox,
        // and can be a wrapper
        trackedObjects = unwrap(e.to);
        analyzeTrackedObjects(cx, analyzer, trackedObjects, done);
        return true;
      }
    }))
      return;
  }
  console.error("Unable to find magic object");
}
function analyzeTrackedObjects(cx, analyzer, trackedObjects, done) {
  // Now, `trackedObjects` is an array of wrappers, So unwrapped
  // them before trying to print information on tracked objects
  let elements = trackedObjects.edges.filter(function (e) {
    // get only array elements
    return !!e.name.match(/objectElements\[(\d+)\]/);
  }).map(function (e) {
    // get edges target object
    return e.to;
  });
  
  let result = elements.map(function (o, i) {
    // unwrap wrappers
    let obj = unwrap(o);
    // Set some additional data to the object given to the view
    let metadata = memapi.getObjectMetadata(i++);
    obj.location = metadata.location;
    // We have to ignore the edge from `magicObject[magicId]` to our tracked object
    obj.owners = obj.owners.filter(function (e) {
      return e.from !== o;
    })
    return obj;
  });
  done(result);
}

function unwrap(o) {
  if (o.name != "JS Object (Proxy)")
    return o;
  return getEdgeFromEdgeName(o, "private");
}

function getEdgeFromEdgeName(obj, name) {
  for (let i = 0; i < obj.edges.length; i++) {
    let e = obj.edges[i];
    if (e.name == name)
      return e.to;
  }
}
function getOwnerFromEdgeName(obj, name) {
  for (let i = 0; i < obj.owners.length; i++) {
    let e = obj.owners[i];
    if (e.name == name)
      return e.from;
  }
}
function getEdgesFromEdgeName(obj, name) {
  return obj.edges.filter(function (e) {
    return e.name == name;
  }).map(function (e) {
    return e.to;
  });
}
function getOwnersFromEdgeName(obj, name) {
  return obj.owners.filter(function (e) {
    return e.name == name;
  }).map(function (e) {
    return e.from;
  });
}

function getObjectTitle(cx, o, edgeName) {
  if (o.name == "JS Object (Call)") {
    // JS OBject (Call) <-- fun-callscope -- JS Object (Function)
    let fun = getOwnerFromEdgeName(o, "fun_callscope");
    if (fun) {
      let m = fun.name.match(/Function - (\w+)\)/);
      if (m)
        return "Scope of function:" + m[1] +
               (edgeName ? ", var:" + edgeName : "");
    }
    return "Scope";
  }
  
  if (o.name == "nsXPCWrappedJS (nsIDOMEventListener)") {
    // nsXPCWrappedJS (nsIDOMEventListener) <-- mListeners[i] -- nsEventListenerManager
    // <-- [via hash] mListenerManager -- FragmentOrElement
    let listenerManagers = getOwnersFromEdgeName(o, "mListeners[i]");
    let fragments = listenerManagers.reduce(function (list, manager) {
      return list.concat(manager.owners.map(function (e) e.from));
    }, []);
    fragments = fragments.map(getObjectTitle.bind(null, cx));
    return "Set as listener on (" + fragments + ")";
  }
  if (o.name == "JS Object (Proxy)") {
    // JS Object (Proxy) -- private --> *
    let wrappedObject = unwrap(o);
    if (wrappedObject)
      return "Wrapper for " + getObjectTitle(cx, wrappedObject);
    else
      return "Dead wrapper";
  }
  if (o.name == "JS Object (Object)") {
    return "JS Object";
  }
  if (o.name == "JS Object (Function)") {
    return "Anonymous function";
  }
  let m = o.name.match(/JS Object \((XUL\w+)\)/);
  if (m)
    return m[1];
  m = o.name.match(/JS Object \(Function - (\w+)\)/);
  if (m)
    return "Function " + m[1];
  return o.name;
}

function getEdgePrettyName(obj, edgeName, target) {
  if (obj.name.indexOf("JS Object") == 0) {
    if (edgeName == "parent")
      return "Global object";
    if (edgeName == "type_proto")
      return "prototype";
  }
  return edgeName;
}

function getObjectDescription(cx, target, edgeName) {
  var data;
  if (target.name == "JS Object (Call)") {
    kind = "scope";
    data = dumpScope(cx, target, edgeName);
  }
  else {
    kind = "generic";
  }
  return {
    object: target,
    name: edgeName,
    kind: kind,
    data: data
  };
}

function dumpScope(cx, o, varname) {
  let fun = getOwnerFromEdgeName(o, "fun_callscope");
  let parent = getEdgeFromEdgeName(o, "parent");
  let binded = false;
  if (parent && parent.name.indexOf("JS Object (Function") == 0) {
    binded = true;
    fun = parent;
  }
  let variables = o.edges.filter(function (e) {
    return !e.name.match(/parent|UNKNOWN SLOT/);
  });
  variables = variables.map(function (e) {
    return {name: e.name, target: e.to};
  });
  //let obj = jsapi.getPointerForAddress(fun.address);
  return {
    binded: binded,
    varname: varname,
    variables: variables,
    source: "[source]"//jsapi.stringifyFunction(cx, obj)
  };
}

