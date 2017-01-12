/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const { Cc, Ci, Cu } = require("chrome");

const {CCAnalyzer} = require("devtools/client/shared/cc-analyzer");

let reportLeaks = aResults => {
  dump("reportLeaks\n");
  function describe(label, o, resolveProxy = true) {
    dump(" >> "+label+" ("+o.name+" - "+o.address+")\n");
    if (o.name == "JS Object (Window)") {
      dump("  JS Window object\n");
      let inner = o.edges.filter(a=>a.name == "UnwrapDOMObject(obj)");
      if (inner.length > 0) {
        inner = inner[0].to;
        let m = inner.name.match(/nsGlobalWindow #\d+ inner (.+)/);
        if (m && m[1]) {
          dump("  For document: "+m[1]+"\n");
        } else {
          describe("inner window", inner);
        }
      }
    } else if (o.name == "JS Object (BackstagePass)") {
      dump("  JS Backstage pass\n");
      /*
      let p = o.edges.filter(a=>a.name == "__LOCATION__");
      if (p.length > 0) {
        describe("__location__", p[0].to);
      }
      if (p.length > 0) {
        describe("exported_symbols", p[0].to);
      }
      */
      //let p = o.edges.filter(a=>a.name == "EXPORTED_SYMBOLS");
      dump(" edges: "+o.edges.map(a=>a.name).join(", ")+"\n");
    } else if (o.name == "JS Object (Proxy)" && resolveProxy) {
      dump("  JS Proxy Object for:\n");
      let priv = o.edges.filter(a=>a.name == "private");
      if (priv.length > 0) {
        describe("proxy target", priv[0].to);
      }
    } else if (o.name == "JS Object (Array)") {
      dump("  Array:");
      o.edges.filter(a=>a.name == "objectElementsOwner")
       .forEach((e, i) => {
         describe("#" + i, e.to);
       });
    } else {
      dump("owners:\n"+o.owners.map(a => " - "+a.name+": "+a.from.name).join("\n")+"\n");
      dump("edges:\n"+o.edges.map(a => " - "+a.name+": "+a.to.name).join("\n")+"\n");
    }
  }
  for (let result of aResults) {
    dump("Got one leak: "+result.name+"\n");
    let analyzer = result.analyzer;
    // We got the nsGlobalWindow object
    // but this doesn't have the compartment information,
    // So look for the JS window object
    let win = analyzer.graph[result.address];
    let jsWin;
    for(let o of win.owners) {
      if (o.from.name.includes("JS Object (Window)")) {
        jsWin = o.from;
        break;
      }
    }
    if (!jsWin) {
      dump("!!! Unable to find the related JS window for this leak. "+result.name+"\n");
      describe("nsGlobal", win);
      continue;
    }

    let compartment = jsWin.compartment;
      
    function findCompartmentRoot(compartment) {
      let g = analyzer.graph;
      for (let i in g) {
        let o = g[i];
        if (o.compartment == compartment && o.name.match(/\((Window|BackstagePass|Sandbox)\)/)) {
          return o;
        }
      }
      return null;
    }

    dump(" >>>>>>>>>>>>>>>>>>>>>>>> COMPARTMENT >>> "+compartment+"\n");
    function root(node, dest, env) {
      if (!env) {
        env = {
          root: null,
          seen: new Set(),
          leaks: [],
          path: []
        };
      }
      let { seen, path } = env;
      if (seen.has(node)) {
        return env;
      }
      seen.add(node);
      if (node == dest) {
        env.root = node;
        //dump("Found root!\n");
        return env;
      }
      let c = dest.compartment;
      if (!node.owners.length) {
        //dump("no owner - "+node.name+"!\n");
      }
      //dump("owners: "+node.owners.map(o=>o.name)+"\n");
      node.owners.some(function (n) {
        if (!n.from.compartment) {
          //dump("owner without compartment ."+n.name+" = "+n.from.name+"\n");
        }
        if (n.from.compartment != c) {
          //dump("owner with different compartment ."+n.name+" = "+n.from.name+"\n");
          if (n.name == "private" && n.from.name == "JS Object (Proxy)") {
            //dump("cross compartment leak\n");
            path.push({ node: n.from, edgeName: "(cross-compartment) " + n.name });
            let r = findCompartmentRoot(n.from.compartment);
            env.leaks.push(n.from);
            return root(n.from, r, env);
          }
          return false;
        }
        //dump("looking into ."+n.name+" = "+n.from.name+"\n");
        if (root(n.from, dest, env).root) {
          path.push({ node: n.from, edgeName: n.name });
          if (n.from.name == "JS Object (Call)") {
            dump("got into closure with variables: "+n.from.edges.map(e=>e.name)+"\n");
          }
          return true;
        }
      });
      return env;
    }

    let sources = new Set();
    for (let edge of analyzer.edges) {
      if (edge.from.compartment && edge.from.compartment != compartment && edge.to.compartment == compartment) {
        let from = edge.from, to = edge.to;
        sources.add(edge.from);
        let o = findCompartmentRoot(edge.from.compartment);
        dump("Ref(edge:"+edge.name+" owners:"+from.owners.map(a=>a.name)+" edges:"+to.edges.map(a=>a.name)+" global:"+o.name+"["+o.edges.length+"])\n");
      }
    }

    let roots = new Set();
    new Set(sources).forEach(function(node) {
      let o = findCompartmentRoot(node.compartment);
      roots.add(o);
      dump(" ## leaking from: "+o.name+" ["+node.address+"]\n");
      dump("leak source: "+node.name+" c:"+node.compartment+"\n");
      dump("leak global: "+o.name+" c:"+o.compartment+"\n");
      let r = root(node, o);
      if (r.root) {
        dump("leak root: "+r.root.name+" c:"+r.root.compartment+"\n");
        if (r.root.compartment != node.compartment) {
          sources = new Set([...sources].filter(n => n.compartment != node.compartment));
          //roots.delete(o);
        }
      }
      if (r.path) {
        dump("path to root: "+r.path.map(p => p.edgeName).join(", ")+"\n");
        r.path.forEach(p => {
          if (p.node.compartment != node.compartment) {
            sources = new Set([...sources].filter(n => n.compartment != node.compartment));
            //roots.delete(o);
          }
          if (r.root && p.node.compartment != r.root.compartment) {
            sources = new Set([...sources].filter(n => n.compartment != p.node.compartment));
          }
        });
      } else {
        dump("no path to root\n");
      }

      let subLeak = r.path.some(l => sources.has(l.node));
      if (subLeak) {
        sources.delete(node);
      }
      dump("Sub leaks: "+subLeak+"\n\n");
      dump("\n\n");
    });
    dump("\n\n @@@@@@@@@@@@@ Final leaks\n");
    sources.forEach(function(node) {
      dump(" @@ ["+node.address+"]\n");
    });
  }
};

exports.checkForLeaks = function () {
  return new Promise(done => {
    Cu.forceGC();Cu.forceCC();
    Cu.schedulePreciseShrinkingGC(() => {
      let s = new Date().getTime();
      let analyzer = new CCAnalyzer();
      console.log("analyzer", analyzer);
      let window = Services.wm.getMostRecentWindow(null);
      analyzer.run(window, () => {
        let results = [];
        for (let obj of analyzer.find("nsGlobalWindow ")) {
          dump(">> "+obj.name+"\n");
          let m = obj.name.match(/^nsGlobalWindow # (\d+)/);
          if (m && m[1] && obj.name.includes("about:devtools-toolbox")) {
            results.push({ name: obj.name, url: m[1], address: obj.address, analyzer: analyzer });
            break;
          }
        }
        dump("leaks for window ?"+results.length+" in "+(new Date().getTime() -s)+"ms\n");
        reportLeaks(results);

        done();
      }, true);
    });
  });
};
