// Copyright (C) 2021 Toitware ApS. All rights reserved.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

import { isTransientError, Uint8Buffer, sleep } from "./util";
import {
  AlreadyRunningError,
  NotRunningError,
  ReadAlreadyInProgressError,
  TimeoutError,
  NotListeningError,
} from "./errors";

export type Unlisten = () => void;

export class Reader {
  private buffer: Uint8Buffer;

  private running = false;
  private closing = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined = undefined;
  private completer: Completer<void> | undefined = undefined;
  private runPromise: Promise<void> | undefined = undefined;
  private listenRef = 0;

  public constructor() {
    this.buffer = new Uint8Buffer();
  }

  public start(readable: ReadableStream<Uint8Array>): void {
    if (this.runPromise !== undefined) {
      throw AlreadyRunningError;
    }

    this.buffer.reset();
    this.closing = false;
    this.runPromise = this.run(readable);
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
      return e as unknown;
    } finally {
      this.buffer.reset();
      this.runPromise = undefined;
    }
  }

  private async run(readable: ReadableStream<Uint8Array>): Promise<void> {
    try {
      this.running = true;
      while (!this.closing) {
        if (this.reader === undefined) {
          this.reader = readable.getReader();
        }
        try {
          const { value, done } = await this.reader.read();

          if (done) {
            this.reader.releaseLock();
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
    while (true) {
      await this.waitData(minLength, timeoutMs);

      const res = this.buffer.packet();
      if (res !== undefined) {
        return res;
      }
    }
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
