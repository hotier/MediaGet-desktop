/**
 * IPC 环境类型（不直接 import electron 的结构子集，便于 vitest 用假 ipcMain 测 registerIpc）
 */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, input: unknown) => Promise<unknown> | unknown
  ): void;
}
