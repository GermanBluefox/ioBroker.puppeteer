"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_puppeteer = __toESM(require("puppeteer"));
var import_tools = require("./lib/tools");
var import_node_path = require("node:path");
var import_webserver = require("@iobroker/webserver");
var import_express = __toESM(require("express"));
var import_cookie_parser = __toESM(require("cookie-parser"));
var import_body_parser = __toESM(require("body-parser"));
var import_adapter_core = require("@iobroker/adapter-core");
class AsyncQueue {
  constructor(maxConcurrent) {
    this.queue = [];
    this.activeCount = 0;
    this.maxConcurrent = maxConcurrent;
  }
  async add(task) {
    if (this.maxConcurrent === 0) {
      return task();
    }
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise((resolve2) => this.queue.push(resolve2));
    }
    this.activeCount++;
    try {
      return await task();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) {
          next();
        }
      }
    }
  }
}
class PuppeteerAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "puppeteer" });
    this.webServer = {
      app: null,
      server: null
    };
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    let additionalArgs;
    this.renderQueue = new AsyncQueue(this.config.maxParallelRenders || 0);
    if (this.config.secure) {
      await new Promise(
        (resolve2) => this.getCertificates(void 0, void 0, void 0, (_err, certificates) => {
          this.certificates = certificates;
          resolve2();
        })
      );
    }
    if (this.config.additionalArgs) {
      additionalArgs = this.config.additionalArgs.map((entry) => entry.Argument);
    }
    this.log.debug(`Additional arguments: ${JSON.stringify(additionalArgs)}`);
    this.browser = await import_puppeteer.default.launch({
      headless: true,
      defaultViewport: null,
      executablePath: this.config.useExternalBrowser ? this.config.executablePath : void 0,
      args: additionalArgs
    });
    this.subscribeStates("url");
    this.log.info("Ready to take screenshots");
    if (this.config.allowWebAccess) {
      await this.initWebServer();
    }
  }
  /**
   * Is called when the adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback callback which needs to be called
   */
  async onUnload(callback) {
    try {
      if (this.webServer.server) {
        this.log.info(`terminating http${this.config.secure ? "s" : ""} server on port ${this.config.port}`);
        this.webServer.server.close();
        this.webServer.server = null;
      }
    } catch {
    }
    try {
      if (this.browser) {
        this.log.info("Closing browser");
        await this.browser.close();
        this.browser = void 0;
      }
      callback();
    } catch {
      callback();
    }
  }
  /**
   * Is called when a message received
   *
   * @param obj the ioBroker message object
   */
  async onMessage(obj) {
    if (!this.browser) {
      return;
    }
    this.log.debug(`Message: ${JSON.stringify(obj)}`);
    if (obj.command === "screenshot") {
      let url;
      let options;
      if (typeof obj.message === "string") {
        url = obj.message;
        options = {};
      } else {
        url = obj.message.url;
        options = obj.message;
        delete options.url;
      }
      const { waitMethod, waitParameter } = PuppeteerAdapter.extractWaitOptionFromMessage(options);
      const { storagePath } = PuppeteerAdapter.extractIoBrokerOptionsFromMessage(options);
      const viewport = PuppeteerAdapter.extractViewportOptionsFromMessage(options);
      try {
        if (options.path) {
          this.validatePath(options.path);
        }
        await this.renderQueue.add(async () => {
          const page = await this.browser.newPage();
          if (viewport) {
            await page.setViewport(viewport);
          }
          await page.goto(url, { waitUntil: "networkidle2" });
          if (waitMethod && waitMethod in page) {
            await page[waitMethod](waitParameter);
          }
          const img = await page.screenshot(options);
          if (storagePath) {
            this.log.debug(`Write file to "${storagePath}"`);
            await this.writeFileAsync("0_userdata.0", storagePath, Buffer.from(img));
          }
          await page.close();
          this.sendTo(obj.from, obj.command, { result: img }, obj.callback);
        });
      } catch (e) {
        this.log.error(`Could not take screenshot of "${url}": ${e.message}`);
        this.sendTo(obj.from, obj.command, { error: e }, obj.callback);
      }
    } else {
      this.log.error(`Unsupported message command: ${obj.command}`);
      this.sendTo(
        obj.from,
        obj.command,
        { error: new Error(`Unsupported message command: ${obj.command}`) },
        obj.callback
      );
    }
  }
  /**
   * Is called if a subscribed state changes
   *
   * @param id id of the changed state
   * @param state the state object
   */
  async onStateChange(id, state) {
    if (!this.browser) {
      return;
    }
    if (state && state.val && !state.ack) {
      const options = await this.gatherScreenshotOptions();
      if (!options.path) {
        this.log.error("Please specify a filename before taking a screenshot");
        return;
      }
      try {
        this.validatePath(options.path);
      } catch (e) {
        this.log.error(`Cannot take screenshot: ${e.message}`);
        return;
      }
      this.log.debug(`Screenshot options: ${JSON.stringify(options)}`);
      this.log.info(`Taking screenshot of "${state.val}"`);
      try {
        await this.renderQueue.add(async () => {
          const page = await this.browser.newPage();
          await page.goto(state.val, { waitUntil: "networkidle2" });
          await this.waitForConditions(page);
          await page.screenshot(options);
          this.log.info("Screenshot sucessfully saved");
          await this.setStateAsync(id, state.val, true);
          await page.close();
        });
      } catch (e) {
        this.log.error(`Could not take screenshot of "${state.val}": ${e.message}`);
      }
    }
  }
  /**
   * Determines the ScreenshotOptions by the current configuration states
   */
  async gatherScreenshotOptions() {
    const options = {};
    const filenameState = await this.getStateAsync("filename");
    if (filenameState && filenameState.val) {
      options.path = filenameState.val;
    }
    const fullPageState = await this.getStateAsync("fullPage");
    if (fullPageState) {
      options.fullPage = !!fullPageState.val;
    }
    if (!options.fullPage) {
      const clipOptions = await this.gatherScreenshotClipOptions();
      if (clipOptions) {
        options.clip = clipOptions;
      }
    } else {
      this.log.debug("Ignoring clip options, because full page is desired");
    }
    return options;
  }
  /**
   * Determines the ScreenshotClipOptions by the current configuration states
   */
  async gatherScreenshotClipOptions() {
    const options = {};
    const clipAttributes = {
      clipLeft: "x",
      clipTop: "y",
      clipHeight: "height",
      clipWidth: "width"
    };
    for (const [id, attributeName] of Object.entries(clipAttributes)) {
      const clipAttributeState = await this.getStateAsync(id);
      if (clipAttributeState && typeof clipAttributeState.val === "number") {
        options[attributeName] = clipAttributeState.val;
      } else {
        this.log.debug(`Ignoring clip, because "${id}" is not configured`);
        return;
      }
    }
    return options;
  }
  /**
   * Validates that the given path is valid to save a screenshot too, prevents node_modules and dataDir
   *
   * @param path path to check
   */
  validatePath(path) {
    path = (0, import_node_path.resolve)((0, import_node_path.normalize)(path));
    this.log.debug(`Checking path "${path}"`);
    if (path.startsWith(utils.getAbsoluteDefaultDataDir())) {
      throw new Error("Screenshots cannot be stored inside the ioBroker storage");
    }
    if (path.includes(`${import_node_path.sep}node_modules${import_node_path.sep}`)) {
      throw new Error("Screenshots cannot be stored inside a node_modules folder");
    }
  }
  /**
   * Waits until the user configured conditions are fullfilled
   *
   * @param page active page object
   */
  async waitForConditions(page) {
    var _a, _b;
    const selector = (_a = await this.getStateAsync("waitForSelector")) == null ? void 0 : _a.val;
    if (selector && typeof selector === "string") {
      this.log.debug(`Waiting for selector "${selector}"`);
      await page.waitForSelector(selector);
      return;
    }
    const renderTimeMs = (_b = await this.getStateAsync("renderTime")) == null ? void 0 : _b.val;
    if (renderTimeMs && typeof renderTimeMs === "number") {
      this.log.debug(`Waiting for timeout "${renderTimeMs}" ms`);
      await this.delay(renderTimeMs);
      return;
    }
  }
  /**
   * Extracts the ioBroker specific options from the message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractIoBrokerOptionsFromMessage(options) {
    var _a;
    let storagePath;
    if (typeof ((_a = options.ioBrokerOptions) == null ? void 0 : _a.storagePath) === "string") {
      storagePath = options.ioBrokerOptions.storagePath;
    }
    delete options.ioBrokerOptions;
    return { storagePath };
  }
  /**
   * Extracts the viewport specific options from the message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractViewportOptionsFromMessage(options) {
    let viewportOptions;
    if ((0, import_tools.isObject)(options.viewportOptions) && typeof options.viewportOptions.width === "number" && typeof options.viewportOptions.height === "number") {
      viewportOptions = options.viewportOptions;
    }
    delete options.viewportOptions;
    return viewportOptions;
  }
  async initWebServer() {
    this.config.port = parseInt(this.config.port || "10000", 10);
    this.webServer.app = (0, import_express.default)();
    if (this.config.port) {
      if (this.config.secure && !this.certificates) {
        return;
      }
      try {
        const webserver = new import_webserver.WebServer({
          app: this.webServer.app,
          adapter: this,
          secure: this.config.secure
        });
        this.webServer.server = await webserver.init();
        if (this.config.auth) {
          this.webServer.app.use((0, import_cookie_parser.default)());
          this.webServer.app.use(import_body_parser.default.urlencoded({ extended: true }));
          this.webServer.app.use(import_body_parser.default.json());
          (0, import_webserver.createOAuth2Server)(this, {
            app: this.webServer.app,
            secure: this.config.secure,
            accessLifetime: parseInt(this.config.ttl, 10) || 3600
          });
        }
      } catch (err) {
        this.log.error(`Cannot create webserver: ${err}`);
        this.terminate ? this.terminate(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
        return;
      }
      if (!this.webServer.server) {
        this.log.error(`Cannot create webserver`);
        this.terminate ? this.terminate(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
        return;
      }
    } else {
      this.log.error("port missing");
      if (this.terminate) {
        this.terminate(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
      } else {
        process.exit(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
      }
      return;
    }
    if (this.webServer.server) {
      let serverListening = false;
      let serverPort = this.config.port;
      this.webServer.server.on("error", (e) => {
        if (e.toString().includes("EACCES") && serverPort <= 1024) {
          this.log.error(
            `node.js process has no rights to start server on the port ${serverPort}.
Do you know that on linux you need special permissions for ports under 1024?
You can call in shell following scrip to allow it for node.js: "iobroker fix"`
          );
        } else {
          this.log.error(`Cannot start server on ${this.config.bind || "0.0.0.0"}:${serverPort}: ${e}`);
        }
        if (!serverListening) {
          this.terminate ? this.terminate(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(import_adapter_core.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
        }
      });
      this.webServer.app.use(async (req, res, _next) => {
        if (!this.browser) {
          res.status(503).json({ error: "Browser not ready" });
          return;
        }
        const { url } = req.query;
        if (!url || typeof url !== "string") {
          res.status(400).json({ error: "Missing required parameter: url" });
          return;
        }
        try {
          const screenshotOptions = {};
          const viewport = {};
          if (req.query.width) {
            viewport.width = parseInt(req.query.width, 10);
          }
          if (req.query.height) {
            viewport.height = parseInt(req.query.height, 10);
          }
          if (req.query.fullPage !== void 0) {
            screenshotOptions.fullPage = req.query.fullPage === "true" || req.query.fullPage === "1";
          }
          if (!screenshotOptions.fullPage && req.query.clipTop !== void 0 && req.query.clipLeft !== void 0 && req.query.clipWidth !== void 0 && req.query.clipHeight !== void 0) {
            screenshotOptions.clip = {
              x: parseFloat(req.query.clipLeft),
              y: parseFloat(req.query.clipTop),
              width: parseFloat(req.query.clipWidth),
              height: parseFloat(req.query.clipHeight)
            };
          }
          if (req.query.quality !== void 0) {
            screenshotOptions.quality = parseInt(req.query.quality, 10);
          }
          if (req.query.omitBackground !== void 0) {
            screenshotOptions.omitBackground = req.query.omitBackground === "true" || req.query.omitBackground === "1";
          }
          const encoding = req.query.encoding === "base64" || req.query.encoding === "binary" ? req.query.encoding : "binary";
          if (req.query.captureBeyondViewport !== void 0) {
            screenshotOptions.captureBeyondViewport = req.query.captureBeyondViewport !== "false" && req.query.captureBeyondViewport !== "0";
          }
          await this.renderQueue.add(async () => {
            var _a, _b;
            const page = await this.browser.newPage();
            const type = req.query.type || "png";
            if (type === "jpeg" || type === "jpg") {
              screenshotOptions.type = "jpeg";
            } else if (type === "webp") {
              screenshotOptions.type = "webp";
            }
            if (viewport.width || viewport.height) {
              await page.setViewport({
                width: (_a = viewport.width) != null ? _a : 1280,
                height: (_b = viewport.height) != null ? _b : 720
              });
            }
            await page.goto(url, { waitUntil: "networkidle2" });
            const waitForSelector = req.query.waitForSelector;
            const waitForTimeout = req.query.waitForTimeout ? parseInt(req.query.waitForTimeout, 10) : void 0;
            if (waitForSelector) {
              this.log.debug(`[web] Waiting for selector "${waitForSelector}"`);
              await page.waitForSelector(waitForSelector);
            } else if (waitForTimeout) {
              this.log.debug(`[web] Waiting for timeout "${waitForTimeout}" ms`);
              await this.delay(waitForTimeout);
            }
            this.log.info(`[web] Taking screenshot of "${url}"`);
            const img = await page.screenshot(screenshotOptions);
            await page.close();
            if (encoding === "base64") {
              const base64 = Buffer.from(img).toString("base64");
              res.json({ result: base64 });
            } else {
              const mimeType = screenshotOptions.type === "jpeg" ? "image/jpeg" : screenshotOptions.type === "webp" ? "image/webp" : "image/png";
              res.setHeader("Content-Type", mimeType);
              res.send(Buffer.from(img));
            }
          });
        } catch (e) {
          this.log.error(`[web] Could not take screenshot of "${url}": ${e.message}`);
          res.status(500).json({ error: e.message });
        }
      });
      this.getPort(
        this.config.port,
        !this.config.bind || this.config.bind === "0.0.0.0" ? void 0 : this.config.bind || void 0,
        (port) => {
          if (port !== this.config.port) {
            this.log.error(`port ${this.config.port} already in use`);
            if (this.terminate) {
              this.terminate(1);
            } else {
              process.exit(1);
            }
            return;
          }
          serverPort = port;
          if (this.webServer.server) {
            this.webServer.server.listen(
              port,
              !this.config.bind || this.config.bind === "0.0.0.0" ? void 0 : this.config.bind || void 0,
              () => serverListening = true
            );
            this.log.info(`http${this.config.secure ? "s" : ""} server listening on port ${port}`);
          } else {
            this.log.error("server initialization failed");
            if (this.terminate) {
              this.terminate(1);
            } else {
              process.exit(1);
            }
          }
        }
      );
    }
  }
  /**
   * Extracts the waitOption from a message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractWaitOptionFromMessage(options) {
    let waitMethod;
    let waitParameter;
    if ("waitOption" in options) {
      if ((0, import_tools.isObject)(options.waitOption)) {
        waitMethod = Object.keys(options.waitOption)[0];
        waitParameter = Object.values(options.waitOption)[0];
      }
      delete options.waitOption;
    }
    return { waitMethod, waitParameter };
  }
}
if (require.main !== module) {
  module.exports = (options) => new PuppeteerAdapter(options);
} else {
  (() => new PuppeteerAdapter())();
}
//# sourceMappingURL=main.js.map
