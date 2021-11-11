// Copyright (C) 2021 Toitware ApS. All rights reserved.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

import {
  AlreadyRunningError,
  NotListeningError,
  NotRunningError,
  ReadAlreadyInProgressError,
  TimeoutError,
} from "./errors";
import { isTransientError, sleep, Uint8Buffer } from "./util";

export type Unlisten = () => void;

export interface ReadableOwner {
  readonly readable: ReadableStream<Uint8Array>;
}

export class Reader {
  private buffer: Uint8Buffer;
  private readableOwner: ReadableOwner;

  private running = false;
  private closing = false;

  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined = undefined;
  private completer: Completer<void> | undefined = undefined;
  private runPromise: Promise<void> | undefined = undefined;
  private listenRef = 0;

  public constructor(readableOwner: ReadableOwner) {
    this.buffer = new Uint8Buffer();
    this.readableOwner = readableOwner;
  }

  public start(): void {
    if (this.runPromise !== undefined) {
      throw AlreadyRunningError;
    }

    this.buffer.reset();
    this.closing = false;
    this.runPromise = this.run();
  }

  public async stop(): Promise<unknown> {
    if (this.runPromise === undefined) {
      throw NotRunningError;
    }

    this.closing = true;
    if (this.reader !== undefined) {
      try {
        await this.reader.cancel();
      } catch (e) {}
    }
    try {
      await this.runPromise;
      return undefined;
    } catch (e) {
      return e;
    } finally {
      this.buffer.reset();
      this.runPromise = undefined;
    }
  }

  private async run(): Promise<void> {
    try {
      this.running = true;
      while (!this.closing) {
        if (this.reader === undefined) {
          this.reader = this.readableOwner.readable.getReader();
        }
        const reader = this.reader;
        try {
          const { value, done } = await reader.read();

          if (done) {
            reader.releaseLock();
            this.reader = undefined;
            await sleep(1);
            continue;
          }

          if (!value) {
            continue;
          }

          if (this.listenRef > 0) {
            this.buffer.copy(value);
          }

          if (this.completer !== undefined) {
            this.completer.complete();
          }
        } catch (e) {
          if (!isTransientError(e)) {
            throw e;
          }

          // on a transient error, close the current reader and retry.
          try {
            await reader.cancel();
          } catch (e) {}
          reader.releaseLock();
          this.reader = undefined;
          await sleep(1);
        }
      }
    } finally {
      if (this.reader !== undefined) {
        try {
          await this.reader.cancel();
        } catch (e) {}
        this.reader.releaseLock();
        this.reader = undefined;
      }
      this.running = false;
    }
  }

  public listen(): Unlisten {
    if (!this.running) {
      throw NotRunningError;
    }
    this.listenRef++;
    return () => {
      this.listenRef--;
      if (this.listenRef < 0) {
        throw "Listen ref count is negative";
      }
      if (this.listenRef == 0) {
        this.buffer.reset();
      }
    };
  }

  private async waitData(minLength: number, timeoutMs: number | undefined = undefined): Promise<void> {
    if (!this.running) {
      throw NotRunningError;
    }
    if (this.completer !== undefined) {
      throw ReadAlreadyInProgressError;
    }

    while (this.buffer.length < minLength) {
      this.completer = new Completer<void>(timeoutMs);
      try {
        await this.completer.promise;
      } finally {
        this.completer = undefined;
      }
    }
  }

  public async waitSilent(retry: number, timeoutMs: number): Promise<boolean> {
    while (retry--) {
      this.buffer.reset();
      try {
        await this.waitData(1, timeoutMs);
      } catch (e) {
        if (e === TimeoutError) {
          return true;
        }
        throw e;
      }
      await sleep(50);
    }
    return false;
  }

  public async read(minLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.listenRef <= 0) {
      throw NotListeningError;
    }
    await this.waitData(minLength, timeoutMs);

    return this.buffer.view(true);
  }

  public async packet(minLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.listenRef <= 0) {
      throw NotListeningError;
    }
    let maxRetries = 1000;
    while (maxRetries--) {
      await this.waitData(minLength, timeoutMs);

      const res = this.buffer.packet();
      if (res !== undefined) {
        return res;
      }
      // no packet was available in minLength, so we wait for another byte.
      minLength++;
    }

    throw TimeoutError;
  }
}

export class Completer<T> {
  public readonly promise: Promise<T>;
  private _complete: ((value: PromiseLike<T> | T) => void) | undefined;
  private _reject: ((reason?: unknown) => void) | undefined;

  public constructor(timeoutMs: number | undefined = undefined) {
    this.promise = new Promise<T>((resolve, reject) => {
      this._complete = resolve;
      this._reject = reject;
      if (timeoutMs !== undefined) {
        if (timeoutMs > 0) {
          setTimeout(() => reject(TimeoutError), timeoutMs);
        } else {
          reject(TimeoutError);
        }
      }
    });
  }

  public complete(value: PromiseLike<T> | T): void {
    if (this._complete !== undefined) {
      this._complete(value);
    }
  }

  public reject(reason?: unknown): void {
    if (this._reject !== undefined) {
      this._reject(reason);
    }
  }
}
