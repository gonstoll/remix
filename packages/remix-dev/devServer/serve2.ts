import compression from "compression";
import { createProxyMiddleware } from "http-proxy-middleware";
import execa from "execa";
import exitHook from "exit-hook";
import express from "express";
import fse from "fs-extra";
import getPort, { makeRange } from "get-port";
import morgan from "morgan";
import type { Server } from "http";
import os from "os";
import path from "path";
import prettyMs from "pretty-ms";
import WebSocket from "ws";

import { createChannel } from "../channel";
import * as Compiler from "../compiler";
import type { RemixConfig } from "../config";

let relativePath = (file: string) => path.relative(process.cwd(), file);

let getHost = () =>
  process.env.HOST ??
  Object.values(os.networkInterfaces())
    .flat()
    .find((ip) => String(ip?.family).includes("4") && !ip?.internal)?.address;

let findPort = async (portPreference?: number) =>
  getPort({
    port: portPreference
      ? Number(portPreference)
      : process.env.PORT
      ? Number(process.env.PORT)
      : makeRange(3001, 3100),
  });

type Broadcast<Event> = (event: Event) => void;
let createBroadcast = <Event>(
  wss: WebSocket.Server,
  options: {
    delayMs: number;
  }
): Broadcast<Event> => {
  let broadcast = (event: Event) => {
    setTimeout(() => {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(event));
        }
      });
    }, options.delayMs);
  };
  return broadcast;
};

let liveReload = async (
  config: RemixConfig,
  options: Compiler.WatchOptions
) => {
  let mode = "development" as const;

  let wss = new WebSocket.Server({ port: config.devServerPort });
  let broadcast = createBroadcast(wss, {
    delayMs: config.devServerBroadcastDelay,
  });
  let log = (message: string) => {
    let _message = `💿 ${message}`;
    console.log(_message);
    broadcast({ type: "LOG", message: _message });
  };

  let dispose = await Compiler.watch(config, {
    mode,
    onInitialBuild: (durationMs) => {
      console.log(`💿 Built in ${prettyMs(durationMs)}`);
      options.onInitialBuild?.(durationMs);
    },
    onRebuildStart() {
      log("Rebuilding...");
      options.onRebuildStart?.();
    },
    async onRebuildFinish(durationMs: number) {
      log(`Rebuilt in ${prettyMs(durationMs)}`);
      await options.onRebuildFinish?.(durationMs);
      broadcast({ type: "RELOAD" });
    },
    onFileCreated(file) {
      log(`File created: ${relativePath(file)}`);
      options.onFileCreated?.(file);
    },
    onFileChanged(file) {
      log(`File changed: ${relativePath(file)}`);
      options.onFileChanged?.(file);
    },
    onFileDeleted(file) {
      log(`File deleted: ${relativePath(file)}`);
      options.onFileDeleted?.(file);
    },
  });

  let channel = createChannel<void>();
  exitHook(async () => {
    // cleanup when process exits e.g. user hits CTRL-C
    wss.close();
    await dispose();
    fse.emptyDirSync(config.assetsBuildDirectory);
    fse.rmSync(config.serverBuildPath);
    channel.write();
  });
  return channel.read();
};

export let serve = async (config: RemixConfig, proxyPort: number) => {
  let app = express();
  app.disable("x-powered-by");
  app.use(compression());

  console.log("public path: " + config.publicPath);
  // handle assets
  app.use(
    config.publicPath,
    express.static(config.assetsBuildDirectory, {
      // fingerprinted assets
      immutable: true,
      maxAge: "1y",
    })
  );

  // proxy everything else to the user-defined server
  let host = getHost();
  let proxy = createProxyMiddleware({
    target: `http://${host ?? "localhost"}:${proxyPort}`,
    // changeOrigin: true, // TODO
  });
  app.use("/*", (req, res, next) => {
    return proxy(req, res, next);
  });

  app.use(morgan("tiny"));

  let port = await findPort();
  let onListen = () => {
    let message = `Remix Dev Server started at http://localhost:${port}`;
    if (host) message += ` (http://${host}:${port})`;
    console.log(message);
  };

  let serverProcess: execa.ExecaChildProcess | undefined;

  let devServer: Server | undefined;
  try {
    await liveReload(config, {
      // TBD_naming_dev: 'node ./server.js',
      // dev: 'ts-node ./server.ts',
      onInitialBuild: () => {
        serverProcess = execa("node", ["server.js"], {
          cwd: config.rootDirectory,
          env: {
            NODE_ENV: "development",
          },
        });

        // race

        // devServer = host
        //   ? app.listen(port, host, onListen)
        //   : app.listen(port, onListen);
        devServer = app.listen(port, onListen);
      },
      onRebuildFinish: async () => {
        serverProcess?.cancel();
        let channel = createChannel<void>();
        // ask if subprocess should be restarted or not. e.g. wrangler/node latest/bun
        serverProcess = execa("node", ["server.js"], {
          cwd: config.rootDirectory,
          env: {
            NODE_ENV: "development",
          },
        });
        // wait until proxy_port is taken by the subprocess
        serverProcess.stdout?.on("data", (data) => {
          console.log(data);
          channel.write();
        });
        await channel.read();
      },
    });
  } finally {
    serverProcess?.cancel();
    devServer?.close();
  }
};
