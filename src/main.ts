import * as utils from '@iobroker/adapter-core';
import type { Page, Browser, ScreenshotOptions, ScreenshotClip, Viewport } from 'puppeteer';
import puppeteer from 'puppeteer';
import { isObject } from './lib/tools';
import { normalize, resolve, sep as pathSeparator } from 'node:path';
import { createOAuth2Server, WebServer } from '@iobroker/webserver';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import { EXIT_CODES } from '@iobroker/adapter-core';

export type Server = HttpServer | HttpsServer;

interface WebStructure {
    server: null | Server;
    app: Express | null;
}

class AsyncQueue {
    private queue: (() => void)[] = [];
    private activeCount = 0;
    private readonly maxConcurrent: number;

    constructor(maxConcurrent: number) {
        this.maxConcurrent = maxConcurrent;
    }

    public async add<T>(task: () => Promise<T>): Promise<T> {
        if (this.maxConcurrent === 0) {
            return task(); // No limit
        }

        if (this.activeCount >= this.maxConcurrent) {
            await new Promise<void>(resolve => this.queue.push(resolve));
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
    private browser: Browser | undefined;
    private renderQueue: AsyncQueue | undefined;

    private certificates: ioBroker.Certificates | undefined;

    private webServer: WebStructure = {
        app: null,
        server: null
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'puppeteer' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        let additionalArgs: string[] | undefined;

        this.renderQueue = new AsyncQueue(this.config.maxParallelRenders || 0);

        if (this.config.secure) {
            // Load certificates
            await new Promise<void>(resolve =>
                this.getCertificates(undefined, undefined, undefined, (_err, certificates): void => {
                    this.certificates = certificates;
                    resolve();
                })
            );
        }

        if (this.config.additionalArgs) {
            additionalArgs = this.config.additionalArgs.map(entry => entry.Argument);
        }

        this.log.debug(`Additional arguments: ${JSON.stringify(additionalArgs)}`);

        this.browser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            executablePath: this.config.useExternalBrowser ? this.config.executablePath : undefined,
            args: additionalArgs
        });
        this.subscribeStates('url');
        this.log.info('Ready to take screenshots');

        if (this.config.allowWebAccess) {
            await this.initWebServer();
        }
    }

    /**
     * Is called when the adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback callback which needs to be called
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.webServer.server) {
                this.log.info(`terminating http${this.config.secure ? 's' : ''} server on port ${this.config.port}`);
                this.webServer.server.close();
                this.webServer.server = null;
            }
        } catch {
            // ignore
        }

        try {
            if (this.browser) {
                this.log.info('Closing browser');
                await this.browser.close();
                this.browser = undefined;
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
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        this.log.debug(`Message: ${JSON.stringify(obj)}`);

        if (obj.command === 'screenshot') {
            let url: string;
            let options: Record<string, any>;

            if (typeof obj.message === 'string') {
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

                await this.renderQueue!.add(async () => {
                    const page = await this.browser!.newPage();

                    if (viewport) {
                        await page.setViewport(viewport);
                    }

                    await page.goto(url, { waitUntil: 'networkidle2' });

                    // if wait options given, await them
                    if (waitMethod && waitMethod in page) {
                        await (page as any)[waitMethod](waitParameter);
                    }

                    const img = await page.screenshot(options);
                    if (storagePath) {
                        this.log.debug(`Write file to "${storagePath}"`);
                        await this.writeFileAsync('0_userdata.0', storagePath, Buffer.from(img));
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
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        // user wants to perform a screenshot
        if (state && state.val && !state.ack) {
            const options: ScreenshotOptions = await this.gatherScreenshotOptions();

            if (!options.path) {
                this.log.error('Please specify a filename before taking a screenshot');
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
                await this.renderQueue!.add(async () => {
                    const page = await this.browser!.newPage();
                    await page.goto(state.val as string, { waitUntil: 'networkidle2' });

                    await this.waitForConditions(page);

                    await page.screenshot(options);

                    // set ack true to inform about screenshot creation
                    this.log.info('Screenshot sucessfully saved');
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
    private async gatherScreenshotOptions(): Promise<ScreenshotOptions> {
        const options: ScreenshotOptions = {};

        // get the path
        const filenameState = await this.getStateAsync('filename');
        if (filenameState && filenameState.val) {
            options.path = filenameState.val as string;
        }

        // check fullPage flag
        const fullPageState = await this.getStateAsync('fullPage');
        if (fullPageState) {
            options.fullPage = !!fullPageState.val;
        }

        if (!options.fullPage) {
            const clipOptions: ScreenshotClip | void = await this.gatherScreenshotClipOptions();

            if (clipOptions) {
                options.clip = clipOptions;
            }
        } else {
            this.log.debug('Ignoring clip options, because full page is desired');
        }

        return options;
    }

    /**
     * Determines the ScreenshotClipOptions by the current configuration states
     */
    private async gatherScreenshotClipOptions(): Promise<ScreenshotClip | void> {
        const options: Partial<ScreenshotClip> = {};

        const clipAttributes = {
            clipLeft: 'x',
            clipTop: 'y',
            clipHeight: 'height',
            clipWidth: 'width'
        } as const;

        for (const [id, attributeName] of Object.entries(clipAttributes)) {
            const clipAttributeState = await this.getStateAsync(id);
            if (clipAttributeState && typeof clipAttributeState.val === 'number') {
                options[attributeName] = clipAttributeState.val;
            } else {
                this.log.debug(`Ignoring clip, because "${id}" is not configured`);
                return;
            }
        }

        return options as ScreenshotClip;
    }

    /**
     * Validates that the given path is valid to save a screenshot too, prevents node_modules and dataDir
     *
     * @param path path to check
     */
    private validatePath(path: string): void {
        path = resolve(normalize(path));
        this.log.debug(`Checking path "${path}"`);

        if (path.startsWith(utils.getAbsoluteDefaultDataDir())) {
            throw new Error('Screenshots cannot be stored inside the ioBroker storage');
        }

        if (path.includes(`${pathSeparator}node_modules${pathSeparator}`)) {
            throw new Error('Screenshots cannot be stored inside a node_modules folder');
        }
    }

    /**
     * Waits until the user configured conditions are fullfilled
     *
     * @param page active page object
     */
    private async waitForConditions(page: Page): Promise<void> {
        // selector has highest priority
        const selector = (await this.getStateAsync('waitForSelector'))?.val;
        if (selector && typeof selector === 'string') {
            this.log.debug(`Waiting for selector "${selector}"`);
            await page.waitForSelector(selector);
            return;
        }

        const renderTimeMs = (await this.getStateAsync('renderTime'))?.val;
        if (renderTimeMs && typeof renderTimeMs === 'number') {
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
    private static extractIoBrokerOptionsFromMessage(options: Record<string, any>): {
        storagePath: string | undefined;
    } {
        let storagePath: string | undefined;
        if (typeof options.ioBrokerOptions?.storagePath === 'string') {
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
    private static extractViewportOptionsFromMessage(options: Record<string, any>): Viewport | undefined {
        let viewportOptions: Viewport | undefined;
        if (
            isObject(options.viewportOptions) &&
            typeof options.viewportOptions.width === 'number' &&
            typeof options.viewportOptions.height === 'number'
        ) {
            viewportOptions = options.viewportOptions as Viewport;
        }

        delete options.viewportOptions;
        return viewportOptions;
    }

    private async initWebServer(): Promise<void> {
        this.config.port = parseInt((this.config.port as string) || '10000', 10);

        this.webServer.app = express();

        if (this.config.port) {
            if (this.config.secure && !this.certificates) {
                return;
            }

            try {
                const webserver = new WebServer({
                    app: this.webServer.app,
                    adapter: this,
                    secure: this.config.secure
                });

                this.webServer.server = await webserver.init();

                if (this.config.auth) {
                    // Install OAuth2 handler
                    this.webServer.app.use(cookieParser());
                    this.webServer.app.use(bodyParser.urlencoded({ extended: true }));
                    this.webServer.app.use(bodyParser.json());

                    createOAuth2Server(this, {
                        app: this.webServer.app,
                        secure: this.config.secure,
                        accessLifetime: parseInt(this.config.ttl as string, 10) || 3600
                    });
                }
            } catch (err) {
                this.log.error(`Cannot create webserver: ${err}`);
                this.terminate
                    ? this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION)
                    : process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
            if (!this.webServer.server) {
                this.log.error(`Cannot create webserver`);
                this.terminate
                    ? this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION)
                    : process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
        } else {
            this.log.error('port missing');
            if (this.terminate) {
                this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            } else {
                process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            }
            return;
        }

        if (this.webServer.server) {
            let serverListening = false;
            let serverPort = this.config.port;

            this.webServer.server.on('error', e => {
                if (e.toString().includes('EACCES') && serverPort <= 1024) {
                    this.log.error(
                        `node.js process has no rights to start server on the port ${serverPort}.\n` +
                            `Do you know that on linux you need special permissions for ports under 1024?\n` +
                            `You can call in shell following scrip to allow it for node.js: "iobroker fix"`
                    );
                } else {
                    this.log.error(`Cannot start server on ${this.config.bind || '0.0.0.0'}:${serverPort}: ${e}`);
                }
                if (!serverListening) {
                    this.terminate
                        ? this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION)
                        : process.exit(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });

            /**
             * GET /screenshot
             *
             * Takes a screenshot of the given URL and returns the image.
             * All parameters are passed as query string parameters.
             *
             * @param req.query.url {string} REQUIRED – The full URL of the page to screenshot (e.g. https://example.com).
             * @param req.query.width {number} Width of the browser viewport in pixels (default: 1280).
             * @param req.query.height {number} Height of the browser viewport in pixels (default: 720).
             * @param req.query.fullPage {boolean} Set to "true" or "1" to capture the entire scrollable page, not just the visible viewport.
             * @param req.query.clipLeft {number} X-coordinate (pixels) of the top-left corner of the clip region. Requires clipY, clipWidth and clipHeight. Ignored when fullPage=true.
             * @param req.query.clipTop {number} Y-coordinate (pixels) of the top-left corner of the clip region. Requires clipX, clipWidth and clipHeight. Ignored when fullPage=true.
             * @param req.query.clipWidth {number} Width (pixels) of the clip region. Requires clipX, clipY and clipHeight. Ignored when fullPage=true.
             * @param req.query.clipHeight {number} Height (pixels) of the clip region. Requires clipX, clipY and clipWidth. Ignored when fullPage=true.
             * @param req.query.quality {number} JPEG compression quality between 0 (lowest) and 100 (highest). Only applicable for JPEG output.
             * @param req.query.omitBackground {boolean} Set to "true" or "1" to make the background transparent. Only applicable for PNG output.
             * @param req.query.encoding {"base64"|"binary"} Output encoding. "base64" returns a JSON { result: "<base64string>" }; "binary" returns raw image bytes (default: "binary").
             * @param req.query.captureBeyondViewport {boolean} Set to "false" or "0" to disable capturing content outside the visible viewport (default: true).
             * @param req.query.waitForSelector {string} CSS selector to wait for before taking the screenshot (e.g. "#loaded"). Takes priority over waitForTimeout.
             * @param req.query.type {"png"|"jpeg"|"webp"} Image format of the screenshot (default: "png"). Use "jpeg" or "webp" together with `quality` for lossy compression.
             * @param req.query.waitForTimeout {number} Milliseconds to wait after page load before taking the screenshot. Only used if waitForSelector is not set.
             */
            this.webServer.app.use(async (req: Request, res: Response, _next: NextFunction) => {
                if (!this.browser) {
                    res.status(503).json({ error: 'Browser not ready' });
                    return;
                }

                const { url } = req.query;

                if (!url || typeof url !== 'string') {
                    res.status(400).json({ error: 'Missing required parameter: url' });
                    return;
                }

                try {
                    const screenshotOptions: ScreenshotOptions = {};
                    const viewport: Partial<Viewport> = {};

                    // -- Viewport: width / height --
                    // Sets the browser window size before navigating; affects what "above the fold" means.
                    if (req.query.width) {
                        viewport.width = parseInt(req.query.width as string, 10);
                    }
                    if (req.query.height) {
                        viewport.height = parseInt(req.query.height as string, 10);
                    }

                    // -- fullPage --
                    // When true, the screenshot covers the entire scrollable document height, not just the visible viewport.
                    if (req.query.fullPage !== undefined) {
                        screenshotOptions.fullPage = req.query.fullPage === 'true' || req.query.fullPage === '1';
                    }

                    // -- clip region (clipX, clipY, clipWidth, clipHeight) --
                    // Crops the screenshot to the given rectangle. All four values are required.
                    // This option is automatically ignored when fullPage is set to true.
                    if (
                        !screenshotOptions.fullPage &&
                        req.query.clipTop !== undefined &&
                        req.query.clipLeft !== undefined &&
                        req.query.clipWidth !== undefined &&
                        req.query.clipHeight !== undefined
                    ) {
                        screenshotOptions.clip = {
                            x: parseFloat(req.query.clipLeft as string),
                            y: parseFloat(req.query.clipTop as string),
                            width: parseFloat(req.query.clipWidth as string),
                            height: parseFloat(req.query.clipHeight as string)
                        };
                    }

                    // -- quality --
                    // JPEG/WebP compression level (0–100). Higher values produce larger but sharper images.
                    // Has no effect for PNG screenshots.
                    if (req.query.quality !== undefined) {
                        (screenshotOptions as any).quality = parseInt(req.query.quality as string, 10);
                    }

                    // -- omitBackground --
                    // When true, the default white page background is replaced with transparency.
                    // Only effective for PNG output; JPEG does not support an alpha channel.
                    if (req.query.omitBackground !== undefined) {
                        screenshotOptions.omitBackground =
                            req.query.omitBackground === 'true' || req.query.omitBackground === '1';
                    }

                    // -- encoding --
                    // Determines the format of the HTTP response:
                    //   "base64" → JSON body { result: "<base64 string>" }
                    //   "binary" → raw image bytes with the matching Content-Type header (default)
                    const encoding: 'base64' | 'binary' =
                        req.query.encoding === 'base64' || req.query.encoding === 'binary'
                            ? req.query.encoding
                            : 'binary';

                    // -- captureBeyondViewport --
                    // When false, Puppeteer restricts the screenshot to the configured viewport area.
                    // Defaults to true so that content rendered outside the viewport is still captured.
                    if (req.query.captureBeyondViewport !== undefined) {
                        screenshotOptions.captureBeyondViewport =
                            req.query.captureBeyondViewport !== 'false' && req.query.captureBeyondViewport !== '0';
                    }

                    await this.renderQueue!.add(async () => {
                        const page = await this.browser!.newPage();

                        const type = req.query.type || 'png';

                        if (type === 'jpeg' || type === 'jpg') {
                            (screenshotOptions as any).type = 'jpeg';
                        } else if (type === 'webp') {
                            (screenshotOptions as any).type = 'webp';
                        }

                        // Apply viewport if width or height provided.
                        // Falls back to 1280×720 when only one dimension is given.
                        if (viewport.width || viewport.height) {
                            await page.setViewport({
                                width: viewport.width ?? 1280,
                                height: viewport.height ?? 720
                            });
                        }

                        await page.goto(url, { waitUntil: 'networkidle2' });

                        // -- waitForSelector / waitForTimeout --
                        // waitForSelector takes priority: Puppeteer blocks until the CSS element appears in the DOM.
                        // If no selector is given, waitForTimeout introduces a plain millisecond delay instead.
                        const waitForSelector = req.query.waitForSelector as string | undefined;
                        const waitForTimeout = req.query.waitForTimeout
                            ? parseInt(req.query.waitForTimeout as string, 10)
                            : undefined;

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

                        if (encoding === 'base64') {
                            const base64 = Buffer.from(img).toString('base64');
                            res.json({ result: base64 });
                        } else {
                            const mimeType =
                                (screenshotOptions as any).type === 'jpeg'
                                    ? 'image/jpeg'
                                    : (screenshotOptions as any).type === 'webp'
                                      ? 'image/webp'
                                      : 'image/png';
                            res.setHeader('Content-Type', mimeType);
                            res.send(Buffer.from(img));
                        }
                    });
                } catch (e: any) {
                    this.log.error(`[web] Could not take screenshot of "${url}": ${e.message}`);
                    res.status(500).json({ error: e.message });
                }
            });

            this.getPort(
                this.config.port,
                !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined,
                port => {
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
                        // create web server
                        this.webServer.server.listen(
                            port,
                            !this.config.bind || this.config.bind === '0.0.0.0'
                                ? undefined
                                : this.config.bind || undefined,
                            () => (serverListening = true)
                        );

                        this.log.info(`http${this.config.secure ? 's' : ''} server listening on port ${port}`);
                    } else {
                        this.log.error('server initialization failed');
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
    private static extractWaitOptionFromMessage(options: Record<string, any>): {
        waitMethod: string | undefined;
        waitParameter: unknown;
    } {
        let waitMethod: string | undefined;
        let waitParameter: unknown;

        if ('waitOption' in options) {
            if (isObject(options.waitOption)) {
                waitMethod = Object.keys(options.waitOption)[0];
                waitParameter = Object.values(options.waitOption)[0];
            }
            delete options.waitOption;
        }

        return { waitMethod, waitParameter };
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PuppeteerAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new PuppeteerAdapter())();
}
