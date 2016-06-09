
let Ci = Components.interfaces;
Components.utils.import('resource://gre/modules/Services.jsm');
let {setTimeout} = Components.utils.import("resource://gre/modules/Timer.jsm", {});

var EXPORTED_SYMBOLS = ['WindowUtils'];

function Channel(content) {
  this.content = content;
  // List of listeners keyed by name and action:
  // this.listeners.get(name).get(action)[x] == callback
  this.listeners = new Map();

  this.origin = null;
  // List of messages which were sent before the channel is ready
  this.queuedMessages = [];

  // List of windowless browsers created for channels
  this.windows = [];
  // Map of channels indexed by name
  this.channels = new Map();
}

Channel.prototype = {
  emit: function(name, action, options) {
    if (this.origin) {
      let channel = this.getChannel(name);
      channel.postMessage({ action, options });
    } else {
      this.queuedMessages.push({ name, action, options });
    }
  },

  on: function(name, action, callback, content) {
    let channelListeners = this.listeners.get(name);
    if (!channelListeners) {
      channelListeners = new Map();
      if (this.origin) {
        let channel = this.getChannel(name);
        channel.addEventListener("message", this);
      }
      this.listeners.set(name, channelListeners);
    }
    let actionListeners = channelListeners.get(action);
    if (!actionListeners) {
      actionListeners = [];
      channelListeners.set(action, actionListeners);
    }
    actionListeners.push(callback);
  },

  // Set the origin for this channel. Starts emiting/listeners for messages.
  // Cleanup previous channels/messages from previously registered origin
  setOrigin: function (origin) {
    this.off();
    this.origin = origin;
    for(let [name, _] of this.listeners) {
      let channel = this.getChannel(name);
      channel.addEventListener("message", this);
    }
    for(let message of this.queuedMessages) {
      let { name } = message;
      delete message.name;
      let channel = this.getChannel(name);
      channel.postMessage(message);
    }
    this.queuedMessages = [];
  },

  handleEvent: function({target, data}) {
    let channelListeners = this.listeners.get(target.name);
    if (!channelListeners) {
      return;
    }
    let action = data.event;
    let actionListeners = channelListeners.get(action);
    if (!actionListeners) {
      return;
    }
    actionListeners.forEach(callback => callback(action, data, target));
  },

  BroadcastChannelFor: function(uri, name, content) {
    let baseURI = Services.io.newURI(uri, null, null);
    let principal = Services.scriptSecurityManager.createCodebasePrincipal(baseURI, content ? {inIsolatedMozBrowser:true} : {});

    let chromeWebNav = Services.appShell.createWindowlessBrowser(true);
    // XXX: Keep a ref to the window otherwise it is garbaged and BroadcastChannel stops working.
    this.windows.push(chromeWebNav);
    let interfaceRequestor = chromeWebNav.QueryInterface(Ci.nsIInterfaceRequestor);
    let docShell = interfaceRequestor.getInterface(Ci.nsIDocShell);
    docShell.createAboutBlankContentViewer(principal);
    let window = docShell.contentViewer.DOMDocument.defaultView;
    return new window.BroadcastChannel(name);
  },

  getChannel: function(name) {
    let channel = this.channels.get(name);
    if (channel) {
      return channel;
    }
    channel = this.BroadcastChannelFor(this.origin, name, this.content);
    this.channels.set(name, channel);
    return channel;
  },

  cloneFunction: function(obj) {
    return WindowUtils.getWindow().then(window => {
      return Components.utils.cloneInto(obj, window, {
        cloneFunctions: true
      });
    });
  },

  cloneInto: function(obj) {
    return WindowUtils.getWindow().then(window => {
      return Components.utils.cloneInto(obj, window);
    });
  },

  off: function () {
    if (this.origin) {
      for(let [name, _] of this.listeners) {
        let channel = this.getChannel(name);
        channel.removeEventListener("message", this);
      }
    }
    this.channels.forEach(channel => {
      try {
        channel.close();
      } catch(e) {}
    });
    this.channels.clear();
    this.windows.forEach(window => window.close());
    this.windows = [];
  },

  destroy: function () {
    this.off();
    this.listeners.clear();
    this.queuedMessages = [];
    this.origin = null;
  }
}

var WindowUtils = new Channel(false);
