
Cu.import("resource://webextensions/api/glue.jsm");
Cu.import("resource://gre/modules/ExtensionUtils.jsm");

var {
    EventManager,
} = ExtensionUtils;

let browserActionMap = new Map();

const INTEGER = /^[1-9]\d*$/;
function normalize(path, extension) {
  let result = {};
  if (typeof path != "object") {
    path = {"19": path};
  }

  let baseURI = extension.baseURI;

  for (let size of Object.keys(path)) {
    if (!INTEGER.test(size)) {
      throw new Error(`Invalid icon size ${size}, must be an integer`);
    }

    let url = baseURI.resolve(path[size]);

    // The Chrome documentation specifies these parameters as
    // relative paths. We currently accept absolute URLs as well,
    // which means we need to check that the extension is allowed
    // to load them. This will throw an error if it's not allowed.
    /*
    Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
      extension.principal, url,
      Services.scriptSecurityManager.DISALLOW_SCRIPT);
    */

    result[size] = url;
  }
  return result;
}

let btnCount = 1;
function BrowserAction(options, extension) {
  let title = extension.localize(options.default_title || "");
  let popup = extension.localize(options.default_popup || "");
  if (popup) {
    popup = extension.baseURI.resolve(popup)
  }
  this._defaults = {
    id: btnCount++,
    enabled: true,
    title: title,
    badgeText: "",
    badgeBackgroundColor: null,
    icon: normalize(options.default_icon, extension),
    popup: popup,
    panel: options.default_panel || "",
    orientation: options.default_orientation || "",
  };
  this._data = this._defaults;
  this._build();
  this._listeners = new Set();
  this.onClick = this.onClick.bind(this);
}
BrowserAction.prototype = {
  _build() {
    this._update(this._data);
    WindowUtils.on('browserAction', "click", this.onClick.bind(this));
  },
  onClick(action, {buttonId}) {
    if (buttonId != this._data.id) {
      return;
    }
    if (this._data.popup) {
      let options = {
        id: this._data.id,
        url: this._data.popup
      };
      WindowUtils.emit('browserAction', 'openPopup', options);
    }
    for(let listener of this._listeners) {
      listener();
    }
  },
  _update(data) {
    WindowUtils.emit('browserAction', 'update', data);
  },
  getProperty(name, tabId) {
    return this._data[name];
  },
  setProperty(name, value, tabId) {
    this._data[name] = value;
    this._update(this._data);
  },
  addClickListener(listener) {
    this._listeners.add(listener);
  },
  removeClickListener(listener) {
    this._listeners.delete(listener);
  },
  shutdown() {
    WindowUtils.emit('browserAction', 'shutdown', this._data);
  }
};

let onManifest = (type, directive, extension, manifest) => {
  let browserAction = new BrowserAction(manifest.browser_action, extension);
  browserActionMap.set(extension, browserAction);
};
extensions.on("manifest_browser_action", onManifest);
extensions.on("shutdown", (type, extension) => {
  if (browserActionMap.has(extension)) {
    browserActionMap.get(extension).shutdown();
    browserActionMap.delete(extension);
  }
});

Services.obs.addObserver(function(subject, topic, data) {
  for (let key of browserActionMap.keys()) {
    let browserAction = browserActionMap.get(key);
    browserAction._update(browserAction._data);
  }
}, 'new-chrome-loaded', false);

extensions.registerSchemaAPI("browserAction", (extension, context) => {
  function getProperty(property, value, tabIdOrDetails) {
    let tabId = typeof(tabIdOrDetails) == "object" && tabIdOrDetails.tabId ?
                tabIdOrDetails.tabId : tabIdOrDetails;
    browserActionMap.get(extension).getProperty(property, value, tabId);
  }
  function setProperty(property, value, tabIdOrDetails) {
    let tabId = typeof(tabIdOrDetails) == "object" && tabIdOrDetails.tabId ?
                tabIdOrDetails.tabId : tabIdOrDetails;
    browserActionMap.get(extension).setProperty(property, value, tabId);
  }
  let browserAction = {
    onClicked: new EventManager(context, "browserAction.onClicked", fire => {
      let listener = () => {
        fire(TabManager.convert(extension, TabManager.activeTab));
      };
      browserActionMap.get(extension).addClickListener(listener);
      return () => {
        browserActionMap.get(extension).removeClickListener(listener);
      };
    }).api(),
    enable(tabId) {
      setProperty("enabled", true, tabId);
    },
    disable(tabId) {
      setProperty("enabled", true, tabId);
    },
    setTitle(details) {
      setProperty("title", details.title, details);
    },
    getTitle(details, callback) {
      getProperty("title", details.title, details);
    },
    setIcon(details, callback) {
      let icon = normalize(details.path, extension)
      setProperty("icon", icon, details);
    },
    setBadgeText(details) {
      setProperty("badgeText", details.text);
    },
    getBadgeText(details, callback) {
      getProperty("badgeText", details);
    },
    setPopup(details) {
      let url = details.popup;
      setProperty("popup", url, details);
    },
    getPopup(details, callback) {
      getProperty("popup", details);
    },
    setBadgeBackgroundColor(details) {
      setProperty("popup", details.color, details);
    },
    getBadgeBackgroundColor(details, callback) {
      getProperty("popup", details);
    },
  }
  return { browserAction };
});

// This has nothing to do here, it should live in its own ext-browserui.js file
let onManifestUI = (type, directive, extension, manifest) => {
  let { browser_ui } = manifest;
  for (let ui in browser_ui) {
    let url = browser_ui[ui];
    if (url) {
      WindowUtils.emit('browserUI', ui, { url });
      dump("manifest browserui["+ui+"] >> "+JSON.stringify(url)+"\n");
    }
  }
};
extensions.on("manifest_browser_ui", onManifestUI);
