
let Cu = Components.utils;
let { require } = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
let { StyleSheetsFront } = require("devtools/server/actors/stylesheets");
let { StorageFront } = require("devtools/server/actors/storage");
let promise = require("promise");

var gToolbox;

var Resource = React.createClass({displayName: "Resource",
  select: function () {
    this.props.onSelect(this);
  },
  render: function () {
    let selected = this.props.selected === this;
    return React.DOM.a({
      className: "resource " + this.props.type + (selected ? " selected" : ""),
      style: { "background-image": "url(moz-icon://." + this.props.type + "?size=16)" },
      onClick: this.select
    },this.props.url);
  }
});

var ResourceList = React.createClass({displayName: "ResourceList",
  render: function () {
    let resources = this.props.resources;
    if (this.props.filter) {
      resources = resources.filter(res => res.url.includes(this.props.filter));
    }
    let items = resources.map(res => {
      res.selected = this.props.selected;
      res.onSelect = this.props.onSelect;
      return React.createElement(Resource, res);
    });
    return React.DOM.div(null,
      React.DOM.h2(null, this.props.type),
      items
    );
  }
});

var Documents = React.createClass({displayName: "Documents",
  getInitialState: function () {
    return { resources: [] };
  },

  componentWillMount: function () {
    let deferred = promise.defer();
    let target = this.props.target;
    target.on("will-navigate", this.reset);
    target.on("navigate", this.update);
    target.on("frame-update", this.updateFrames);
    this.update();    
  },

  reset: function () {
    this.setState({ resources: [] });
  },

  update: function () {
    let target = this.props.target;
    let packet = {
      to: target.form.actor,
      type: "listFrames"
    };
    return target.client.request(packet, resp => {
      this.updateFrames({ frames: resp.frames });
    });
  },

  updateFrames: function (data) {
    if (data.destroyAll) {
      this.setState({ resources });
    } else if (data.selected) {
      this.state.resources.forEach(frame => {
        frame.selected = frame.id == data.selected;
      });
      this.setState(this.state);
    } else if (data.frames) {
      let resources = data.frames.reduce((list, win) => {
        list = list.filter(w => w.id != win.id);
        if (win.destroy) {
          return list;
        }
        list.push({
          type: "html",
          url: win.url,
          id: win.id,
          windowId: win.id,
          parentID: win.parentID,
          selected: false
        });
        return list;
      }, this.state.resources);
      this.setState({ resources: resources });
    }
  },

  render: function () {
    return React.createElement(ResourceList, {
      type: "html",
      resources: this.state.resources,
      selected: this.props.selected,
      filter: this.props.filter,
      onSelect: this.onSelect
    });
  },

  onSelect: function (res) {
    let src = "chrome://devtools/content/inspector/inspector.xul";
    let { InspectorPanel } = require("devtools/client/inspector/inspector-panel");

    let createPanel = (frame, toolbox) => {
      // Switch the toolbox targeted document to the given document
      let target = this.props.target;
      let packet = {
        to: target.form.actor,
        type: "switchToFrame",
        windowId: res.props.id 
      };
      target.client.request(packet);
      toolbox.initInspector(); // XXX: possible race, wait for promise
      return new InspectorPanel(frame.contentWindow, toolbox);
    };
    let onReady = (panel) => {
      let windowId = res.props.windowId;
      if (!panel.isReady) {
        let p = panel.open({});
        p.then(() => {
          panel.walker.setFrameDocument(windowId);
        });
      } else {
        panel.walker.setFrameDocument(windowId);
      }
      panel.open({});
    };


    gToolbox.selectPanel(res, src, createPanel, onReady);
  }
});

var JSResources = React.createClass({displayName: "JSResources",
  getInitialState: function () {
    return { resources: [] };
  },

  componentWillMount: function () {
    let deferred = promise.defer();
    this.threadClient = deferred.promise;
    let threadOptions = {
      useSourceMaps: true,
      autoBlackBox: false,
    };
    let target = this.props.target;
    target.activeTab.attachThread(threadOptions, (aResponse, aThreadClient) => {
      deferred.resolve(aThreadClient);
    });
    target.on("will-navigate", this.reset);
    target.on("navigate", this.update);
    this.update();    
  },

  reset: function () {
    this.setState({ resources: [] });
  },

  update: function () {
    this.threadClient
        .then(threadClient => {
          threadClient.getSources(({ sources }) => {
            let resources = sources.map(source => ({ type: "js", url: source.url, actor: source }));
            resources.push({ type: "newjs", url: "+" });
            this.setState({ resources: resources });
          });
        });
  },

  render: function () {
    return React.createElement(ResourceList, {
      type: "js",
      resources: this.state.resources,
      selected: this.props.selected,
      filter: this.props.filter,
      onSelect: this.onSelect
    });
  },

  onSelect: function (res) {
    if (res.props.type === "js") {
      let src = "chrome://devtools/content/debugger/debugger.xul";
      let { DebuggerPanel } = require("devtools/client/debugger/panel");
      let createPanel = (frame, toolbox) => {
        let panel = new DebuggerPanel(frame.contentWindow, toolbox);
        frame.contentDocument.getElementById("workers-and-sources-pane").style.visibility = "collapse";
        return panel;
      };
      let onReady = (panel) => {
        panel.open({ source: res.props.actor });
      };
      gToolbox.selectPanel(res, src, createPanel, onReady);
    } else if (res.props.type === "newjs") {
      let src = "chrome://devtools/content/scratchpad/scratchpad.xul";
      let { ScratchpadPanel } = require("devtools/client/scratchpad/scratchpad-panel");
      let createPanel = (frame, toolbox) => {
        let panel = new ScratchpadPanel(frame.contentWindow, toolbox);
        return panel;
      };
      let onReady = (panel) => {
        panel.open({});
      };
      gToolbox.selectPanel(res, src, createPanel, onReady);
    }
  }
});

var CSSResources = React.createClass({displayName: "CSSResources",
  getInitialState: function () {
    return { resources: [] };
  },

  componentWillMount: function () {
    let target = this.props.target;
    this.debuggee = StyleSheetsFront(target.client, this.props.target.form);
    target.on("will-navigate", this.reset);
    target.on("navigate", this.update);
    this.update();    
  },

  reset: function () {
    this.setState({ resources: [] });
  },

  update: function () {
    let sheets = [];
    this.debuggee.getStyleSheets().then((styleSheets) => {
      let promises = styleSheets.map(sheet => {
         return sheet.getOriginalSources()
           .then(sources => {
             if (sources && sources.length) {
               sheets = sheets.concat(sources);
             } else {
               sheets.push(sheet);
             }
           });
      });
      return promise.all(promises);
    }).then(() => {
      let inlined = 1;
      let resources = sheets.map(sheet => {
        let url = sheet.href ? sheet.href : "Inline #" + ( inlined++ );
        return { type: "css", url: url, debuggee: this.debuggee, actor: sheet };
      });
      this.setState({ resources: resources });
    });
  },

  render: function () {
    return React.createElement(ResourceList, {
      type: "css",
      resources: this.state.resources,
      selected: this.props.selected,
      filter: this.props.filter,
      onSelect: this.onSelect
    });
  },

  onSelect: function (res) {
    let src = "chrome://devtools/content/styleeditor/styleeditor.xul";
    let { StyleEditorPanel } = require("devtools/client/styleeditor/styleeditor-panel");
    let createPanel = (frame, toolbox) => {
      let panel = new StyleEditorPanel(frame.contentWindow, toolbox);
      panel._debuggee = res.props.debuggee;
      frame.contentDocument.querySelector(".splitview-controller").style.visibility = "collapse";
      return panel;
    };
    let onReady = (panel) => {
      panel.open({ stylesheet: res.props.actor });
    };
    gToolbox.selectPanel(res, src, createPanel, onReady);
  }
});

var StorageResources = React.createClass({displayName: "StorageResources",
  getInitialState: function () {
    return { resources: [] };
  },

  componentWillMount: function () {
    let target = this.props.target;
    this.front = new StorageFront(target.client, target.form);
    target.on("will-navigate", this.reset);
    target.on("navigate", this.update);
    this.update();    
  },

  reset: function () {
    this.setState({ resources: [] });
  },

  update: function () {
    let storages = [];
    this.front.listStores().then(storageTypes => {
      this.storageTypes = storageTypes;
      for (let type in storageTypes) {
        // Ignore `from` field, which is just a protocol.js implementation artifact
        if (type == "from") {
          continue;
        }
        
        if (!storageTypes[type].hosts || Object.keys(storageTypes[type].hosts).length == 0) {
          continue;
        }
        let host = Object.keys(storageTypes[type].hosts)[0];
        storages.push({ type: "storage", url: type, storage: type, host: host, front: this.front });

      }
      this.setState({ resources: storages });
    });
  },

  render: function () {
    return React.createElement(ResourceList, {
      type: "storage",
      resources: this.state.resources,
      selected: this.props.selected,
      filter: this.props.filter,
      onSelect: this.onSelect
     });
  },

  onSelect: function (res) {
    let src = "chrome://devtools/content/storage/storage.xul";
    let { StoragePanel } = require("devtools/client/storage/panel");
    let createPanel = (frame, toolbox) => {
      let panel = new StoragePanel(frame.contentWindow, toolbox);
      panel._front = res.props.front;
      frame.contentDocument.getElementById("storage-tree").style.visibility = "collapse";
      return panel;
    };
    let onReady = (panel) => {
      if (!panel.isReady) {
        panel.open({ type: res.props.storage, host: res.props.host, storageTypes: this.storageTypes });
      } else {
        panel.UI.onHostSelect(null, [res.props.storage, res.props.host]);
      }
    };
    gToolbox.selectPanel(res, src, createPanel, onReady);
  }
});

var Sidebar = React.createClass({displayName: "Sidebar",
  getInitialState: function () {
    return {
      filter: ""
    };
  },
  onFilter: function (event) {
    this.setState({ filter: event.target.value });
  },
  render: function () {
    return React.DOM.div({ id: "sidebar", className: "theme-sidebar" },
      React.DOM.input({id: "search-box", className: "devtools-searchinput",
                       placeholder: "Search for resources...", ref: "search",
                       value: this.state.filter, onChange: this.onFilter}),
      React.DOM.div({id: "resource-tree"},
        React.createElement(Documents, { target: this.props.target, filter: this.state.filter, selected: this.props.selected }),
        React.createElement(JSResources, { target: this.props.target, filter: this.state.filter, selected: this.props.selected }),
        React.createElement(CSSResources, { target: this.props.target, filter: this.state.filter, selected: this.props.selected }),
        React.createElement(StorageResources, { target: this.props.target, filter: this.state.filter, selected: this.props.selected })
      )
    );
  }
});

var Toolbox = React.createClass({displayName: "Toolbox",
  getInitialState: function () {
    return {
      selected: null
    };
  },

  currentPanel : null,

  selectPanel: function (res, src, createPanel, onReady) {
    let type = res.props.type;
    this.setState({ selectedItem: res, selectedType: type });
    
    let frame = this.refs["panel" + type].getDOMNode();
    if (!frame.panel) {
      frame.src = src;
      let f = () => {
        frame.removeEventListener("load", f, true);

        let panel = createPanel(frame, this.props.toolbox);
        frame.panel = panel;
        this.currentPanel = panel;
        onReady(panel);
      };
      frame.addEventListener("load", f, true);
    } else {
      onReady(frame.panel);
    }
  },

  render: function () {
    let tools = ["html", "js", "newjs", "css", "storage"];
    let frames = tools.map(name => {
      return React.DOM.iframe({className: "panel", ref: "panel" + name,
                               style: {display: this.state.selectedType == name ? "block" : "none"}});
    });
    return React.DOM.div({ id: "toolbox" },
      React.createElement(Sidebar, { target: this.props.target, selected: this.state.selectedItem }),
      React.DOM.div({id: "splitter", className: "devtools-side-splitter"}),
      frames
    );
  }
});

function load(toolbox, target) {
  gToolbox = React.render(React.createElement(Toolbox, { toolbox: toolbox, target: target }), document.body);
}
