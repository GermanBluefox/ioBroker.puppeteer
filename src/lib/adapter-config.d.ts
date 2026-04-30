// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /**
             * Additional command-line arguments passed to the Puppeteer browser on launch.
             * Each entry must contain an `Argument` string (e.g. `--no-sandbox`).
             */
            additionalArgs: { Argument: string }[];

            /**
             * When `true`, Puppeteer uses the browser binary defined by `executablePath`
             * instead of the bundled Chromium version.
             */
            useExternalBrowser: boolean;

            /**
             * Absolute path to an external browser executable (e.g. `/usr/bin/google-chrome`).
             * Only relevant when `useExternalBrowser` is `true`.
             */
            executablePath: string;

            /**
             * When `true`, the adapter starts an HTTP(S) web server that accepts
             * screenshot requests via `GET /screenshot?url=...`.
             * Requires `port` to be configured.
             */
            allowWebAccess?: boolean;

            /**
             * TCP port on which the web server listens (default: `10000`).
             * Only used when `allowWebAccess` is `true`.
             */
            port?: number | string;

            /**
             * When `true`, the web server uses HTTPS instead of HTTP.
             * Certificates must be provided via `certPublic`, `certPrivate` and optionally `certChained`.
             */
            secure?: boolean;

            /**
             * When `true`, incoming web requests must be authenticated via OAuth2
             * before a screenshot can be requested.
             */
            auth?: boolean;

            /**
             * Lifetime of an OAuth2 access token in seconds (default: `3600`).
             * Only relevant when `auth` is `true`.
             */
            ttl?: number | string;

            /**
             * IP address or hostname the web server binds to.
             * Use `0.0.0.0` (default) to listen on all network interfaces,
             * or a specific address to restrict access to one interface.
             */
            bind?: string;

            /**
             * PEM-encoded certificate chain / intermediate CA bundle.
             * Used when `secure` is `true` and the CA is not well-known.
             */
            certChained?: string;

            /**
             * PEM-encoded private key matching the TLS certificate.
             * Required when `secure` is `true`.
             */
            certPrivate?: string;

            /**
             * PEM-encoded public TLS certificate presented to HTTPS clients.
             * Required when `secure` is `true`.
             */
            certPublic?: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
