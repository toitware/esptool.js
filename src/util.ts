// Copyright (C) 2021 Toitware ApS. All rights reserved.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Uint8Buffer {
  private readOffset = 0;
  private writeOffset = 0;
  private size: number;

  private _buffer: ArrayBuffer;
  private _view: Uint8Array;

  constructor(size = 64) {
    this.size = size;
    this._buffer = new ArrayBuffer(this.size);
    this._view = new Uint8Array(this._buffer);
  }

  get length(): number {
    return this.writeOffset - this.readOffset;
  }

  shift(): number | undefined {
    if (this.length <= 0) {
      return undefined;
    }
    return this._view[this.readOffset++];
  }

  private grow(newSize: number) {
    const newBuffer = new ArrayBuffer(newSize);
    const newView = new Uint8Array(newBuffer);
    this._view.forEach((v, i) => (newView[i] = v));
    this.size = newSize;
    this._buffer = newBuffer;
    this._view = newView;
  }

  fill(element: number, length = 1): void {
    this.ensure(length);
    this._view.fill(element, this.writeOffset, this.writeOffset + length);
    this.writeOffset += length;
  }

  private ensure(length: number) {
    if (this.size - this.writeOffset < length) {
      const newSize = this.size + Math.max(length, this.size);
      this.grow(newSize);
    }
  }

  private pushBytes(value: number, byteCount: number, littleEndian: boolean) {
    for (let i = 0; i < byteCount; i++) {
      if (littleEndian) {
        this.push((value >> (i * 8)) & 0xff);
      } else {
        this.push((value >> ((byteCount - i) * 8)) & 0xff);
      }
    }
  }

  pack(format: string, ...args: number[]): void {
    let pointer = 0;
    const data = args;
    if (format.replace(/[<>]/, "").length != data.length) {
      throw "Pack format to Argument count mismatch";
    }
    let littleEndian = true;
    for (let i = 0; i < format.length; i++) {
      if (format[i] == "<") {
        littleEndian = true;
      } else if (format[i] == ">") {
        littleEndian = false;
      } else if (format[i] == "B") {
        this.pushBytes(data[pointer], 1, littleEndian);
        pointer++;
      } else if (format[i] == "H") {
        this.pushBytes(data[pointer], 2, littleEndian);
        pointer++;
      } else if (format[i] == "I") {
        this.pushBytes(data[pointer], 4, littleEndian);
        pointer++;
      } else {
        throw "Unhandled character in pack format";
      }
    }
  }

  reset(): void {
    this.writeOffset = 0;
    this.readOffset = 0;
  }

  push(...bytes: number[]): void {
    this.ensure(bytes.length);
    this._view.set(bytes, this.writeOffset);
    this.writeOffset += bytes.length;
  }

  copy(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this._view.set(bytes, this.writeOffset);
    this.writeOffset += bytes.length;
  }

  view(): Uint8Array {
    return new Uint8Array(this._buffer, this.readOffset, this.writeOffset);
  }
}

/**
 * @name Uint8BufferSlipEncode
 * makes a Uint8Buffer with slipEncoding mechanisms.
 * When slipEncode is enabled it:
 *  * replaces 0xdb with 0xdb 0xdd
 *  * and 0xc0 with 0xdb 0xdc
 * for all write operations.
 */
export class Uint8BufferSlipEncode extends Uint8Buffer {
  slipEncode = false;

  push(...bytes: number[]): void {
    if (!this.slipEncode) {
      super.push(...bytes);
    } else {
      bytes.forEach((v) => this.slipEncodeByte(v));
    }
  }

  reset(): void {
    this.slipEncode = false;
    super.reset();
  }

  copy(bytes: Uint8Array): void {
    if (!this.slipEncode) {
      super.copy(bytes);
    } else {
      bytes.forEach((v) => this.slipEncodeByte(v));
    }
  }

  /**
   * @name slipEncodeByte
   * Replaces 0xdb with 0xdb 0xdd and 0xc0 with 0xdb 0xdc
   */
  private slipEncodeByte(v: number) {
    if (v == 0xdb) {
      super.push(0xdb, 0xdd);
    } else if (v == 0xc0) {
      super.push(0xdb, 0xdc);
    } else {
      super.push(v);
    }
  }
}

export function toByteArray(str: string): Uint8Array {
  const byteArray = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const charcode = str.charCodeAt(i);
    byteArray[i] = charcode & 0xff;
  }
  return byteArray;
}

export function toHex(value: number, size = 2): string {
  return "0x" + value.toString(16).toUpperCase().padStart(size, "0");
}
