// background/cloud/storage-adapter.js — Storage adapter factory
//
// Interface contract (duck-typed):
//   init(config) -> Promise<void>
//   upload(encryptedPayload: string) -> Promise<boolean>
//   download() -> Promise<string | null>
//   getLastModified() -> Promise<number | null>
//   testConnection() -> Promise<boolean>

import { createGistAdapter } from "./gist-adapter.js";
import { createWebdavAdapter } from "./webdav-adapter.js";

export function createAdapter(type, config) {
  switch (type) {
    case "gist":
      return createGistAdapter(config);
    case "webdav":
      return createWebdavAdapter(config);
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}
