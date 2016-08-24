const Services = require("Services");
const { Ci } = require("chrome");
const bundle = Services.strings.createBundle("chrome://devtools/locale/toolbox.properties");

loader.lazyRequireGetter(this, "Toolbox", "devtools/client/framework/toolbox", true);
loader.lazyRequireGetter(this, "Hosts", "devtools/client/framework/toolbox-hosts", true);

/**
 * Implement a wrapper on the chrome side to setup a Toolbox within Firefox UI.
 *
 * This components handles iframe creation within Firefox, in which we are loading
 * the toolbox document. Then both the chrome and the toolbox document communicate
 * via "message" events.
 *
 * Messages sent by the toolbox to the chrome:
 * - switch-host: order to display the toolbox in another host (side, bottom or window)
 *
 * Messages sent by the chrome to the toolbox:
 * - host-will-change: tells the toolbox document that the host is about to change
 */

const LAST_HOST = "devtools.toolbox.host";
let ID_COUNTER = 1;

function ToolboxWrapper(target, hostType, hostOptions) {
  this.target = target;

  this.frameId = ID_COUNTER++;

  if (!hostType) {
    hostType = Services.prefs.getCharPref(LAST_HOST);
  }
  this.onHostMinimized = this.onHostMinimized.bind(this);
  this.onHostMaximized = this.onHostMaximized.bind(this);
  this.host = this.createHost(hostType, hostOptions);
}

ToolboxWrapper.prototype = {
  create(toolId) {
    return this.host.create()
      .then(() => {
        this.host.frame.setAttribute("aria-label", bundle.GetStringFromName("toolbox.label"));
        this.host.frame.ownerDocument.defaultView.addEventListener("message", this);
        this.host.frame.addEventListener("unload", this);

        let toolbox = new Toolbox(this.target, toolId, this.host.type, this.host.frame.contentWindow, this.frameId);

        // Prevent reloading the toolbox when loading the tools in a tab (e.g. from about:debugging)
        if (!this.host.frame.contentWindow.location.href.startsWith("about:devtools-toolbox")) {
          this.host.frame.setAttribute("src", "about:devtools-toolbox");
        }

        return toolbox;
      });
  },

  handleEvent(event) {
    switch(event.type) {
      case "message":
        this.onMessage(event);
        break;
      case "unload":
        if (event.target.location.href == "about:blank") {
          break;
        }
        this.destroy();
        break;
    }
  },

  onMessage(event) {
    if (!event.data) return;
    // Toolbox document is still chrome and disallow identifying message
    // origin via event.source as it is null. So use a custom id.
    if (event.data.frameId != this.frameId) {
      return;
    }
    switch (event.data.name) {
      case "switch-host":
        this.switchHost(event.data.hostType);
        break;
      case "maximize-host":
        this.host.maximize();
        break;
      case "raise-host":
        this.host.raise();
        break;
      case "toggle-minimize-mode":
        this.host.toggleMinimizeMode(event.data.toolbarHeight);
        break;
      case "set-host-title":
        this.host.setTitle(event.data.title);
        break;
      case "destroy-host":
        this.destroy();
        break;
    }
  },

  postMessage(data) {
    let window = this.host.frame.contentWindow;
    window.postMessage(data, "*");
  },

  destroy() {
    this.destroyHost();
    this.host = null;
    this.target = null;
  },

  /**
   * Create a host object based on the given host type.
   *
   * Warning: some hosts require that the toolbox target provides a reference to
   * the attached tab. Not all Targets have a tab property - make sure you
   * correctly mix and match hosts and targets.
   *
   * @param {string} hostType
   *        The host type of the new host object
   *
   * @return {Host} host
   *        The created host object
   */
  createHost(hostType, options) {
    if (!Hosts[hostType]) {
      throw new Error("Unknown hostType: " + hostType);
    }

    let newHost = new Hosts[hostType](this.target.tab, options);
    // Update the label and icon when the state changes.
    newHost.on("minimized", this.onHostMinimized);
    newHost.on("maximized", this.onHostMaximized);
    return newHost;
  },

  onHostMinimized() {
    this.postMessage({
      name: "host-minimized"
    });
  },
  onHostMaximized() {
    this.postMessage({
      name: "host-maximized"
    });
  },

  switchHost(hostType) {
    let iframe = this.host.frame;
    let newHost = this.createHost(hostType);
    return newHost.create().then(newIframe => {
      // change toolbox document's parent to the new host
      newIframe.QueryInterface(Ci.nsIFrameLoaderOwner);
      newIframe.swapFrameLoaders(iframe);

      // See bug 1022726, most probably because of swapFrameLoaders we need to
      // first focus the window here, and then once again further from
      // toolbox.js to make sure focus actually happens.
      iframe.contentWindow.focus();

      this.destroyHost();

      this.host = newHost;
      this.host.setTitle(this.host.frame.contentWindow.document.title);
      this.host.frame.ownerDocument.defaultView.addEventListener("message", this);
      this.host.frame.addEventListener("unload", this);

      if (hostType != Toolbox.HostType.CUSTOM) {
        Services.prefs.setCharPref(LAST_HOST, hostType);
      }

      // Tell the toolbox the host changed
      this.postMessage({
        name: "switched-host",
        hostType
      });
    });
  },

  /**
   * Destroy the current host, and remove event listeners from its frame.
   *
   * @return {promise} to be resolved when the host is destroyed.
   */
  destroyHost() {
    this.host.frame.ownerDocument.defaultView.removeEventListener("message", this);
    this.host.frame.removeEventListener("unload", this);

    this.host.off("minimized", this.onHostMinimized);
    this.host.off("maximized", this.onHostMaximized);
    return this.host.destroy();
  }
};
exports.ToolboxWrapper = ToolboxWrapper;
