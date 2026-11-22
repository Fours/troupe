// The /backstage/server entry point: Node only, on node:http (decision 0023). Export only from here.
export { serveBackstage, type BackstageServer, type BackstageServerOptions } from './server.js';
