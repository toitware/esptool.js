// Copyright (C) 2021 Toitware ApS. All rights reserved.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

import { ESP32, Stub } from "./stubs";
import { isTransientError, sleep, toByteArray, toHex, Uint8Buffer, Uint8BufferSlipEncode } from "./util";

export enum ChipFamily {
  ESP32 = "esp32",
  ESP8266 = "esp8266",
  ESP32S2 = "esp32S2",
}

const FLASH_WRITE_SIZE = 0x200;
const ESP32S2_FLASH_WRITE_SIZE = 0x400;

// Flash sector size, minimum unit of erase.
const FLASH_SECTOR_SIZE = 0x1000;
const UART_DATE_REG_ADDR = 0x60000078;

export const ESP_ROM_BAUD = 115200;

const SYNC_PACKET = toByteArray("\x07\x07\x12 UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU");
const ESP32_DATAREGVALUE = 0x15122500;
const ESP8266_DATAREGVALUE = 0x00062000;
const ESP32S2_DATAREGVALUE = 0x500;

const CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;
const ESP32_DETECT_MAGIC_VALUE = 0x00f01d83;
const ESP8266_DETECT_MAGIC_VALUE = 0xfff0c101;
const ESP32S2_DETECT_MAGIC_VALUE = 0x000007c6;

// Commands supported by ESP8266 ROM bootloader
const ESP_FLASH_BEGIN = 0x02;
const ESP_FLASH_DATA = 0x03;
const ESP_FLASH_END = 0x04;
const ESP_MEM_BEGIN = 0x05;
const ESP_MEM_END = 0x06;
const ESP_MEM_DATA = 0x07;
const ESP_SYNC = 0x08;
const ESP_READ_REG = 0x0a;

const ESP_ERASE_FLASH = 0xd0;

const ESP_SPI_SET_PARAMS = 0x0b;
const ESP_SPI_ATTACH = 0x0d;
const ESP_CHANGE_BAUDRATE = 0x0f;
const ESP_CHECKSUM_MAGIC = 0xef;

const ROM_INVALID_RECV_MSG = 0x05;

const USB_RAM_BLOCK = 0x800;

// Timeouts
const DEFAULT_TIMEOUT = 3000; // timeout for most flash operations
const CHIP_ERASE_TIMEOUT = 300000; // timeout for full chip erase
const MAX_TIMEOUT = CHIP_ERASE_TIMEOUT * 2; // longest any command can run
const SYNC_TIMEOUT = 100; // timeout for syncing with bootloader
const ERASE_REGION_TIMEOUT_PER_MB = 30000; // timeout (per megabyte) for erasing a region
const MEM_END_ROM_TIMEOUT = 50;

export type EspLoaderOptions = {
  flashSize: number;
  logger: Logger;
  debug: boolean;
};

export interface Logger {
  debug(message?: unknown, ...optionalParams: unknown[]): void;
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

interface commandResult {
  value: number[];
  data: number[];
}

type progressCallback = (i: number, total: number) => void;

const UnknownChipFamilyError = "Unknown chip family";
const TimeoutError = "timeout";
const ConnectError = "connect error";

export class EspLoader {
  // caches
  private _chipfamily: ChipFamily | undefined;
  private _efuses: Uint32Array | undefined;

  private options: EspLoaderOptions;
  private serialPort: SerialPort;
  private isStub = false;

  // readLoop state
  // private closed = true;
  private readPromise: Promise<Uint8Array> | undefined = undefined;
  private serialReader: ReadableStreamDefaultReader<Uint8Array> | undefined = undefined;
  // private inputBuffer: Uint8Buffer = new Uint8Buffer(64);

  constructor(serialPort: SerialPort, options?: Partial<EspLoaderOptions>) {
    this.options = Object.assign(
      {
        flashSize: 4 * 1024 * 1024,
        logger: console,
        debug: false,
      },
      options || {}
    );
    this.serialPort = serialPort;
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  private async writeToStream(msg: Uint8Array) {
    const writer = this.serialPort.writable.getWriter();
    try {
      await writer.write(msg);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Put into ROM bootload mode & attempt to synchronize with the
   * ESP ROM bootloader, we will retry a few times
   */
  async connect(retries = 7): Promise<void> {
    let connected = false;
    for (let i = 0; i < retries; i++) {
      if (await this.try_connect()) {
        connected = true;
        break;
      }
    }

    if (!connected) {
      throw ConnectError;
    }

    try {
      await this.read2(false, 200);
    } catch (e) {}
  }

  private async try_connect(): Promise<boolean> {
    await this.serialPort.setSignals({ dataTerminalReady: false });
    await this.serialPort.setSignals({ requestToSend: true });
    await sleep(100);
    await this.serialPort.setSignals({ dataTerminalReady: true });
    await this.serialPort.setSignals({ requestToSend: false });
    await sleep(50);
    await this.serialPort.setSignals({ dataTerminalReady: false });
    let i = 0;
    while (true) {
      i++;
      try {
        const p = await this.read2(false, 1000);
        const txt = new TextDecoder().decode(p);
        console.log("read junk", txt);
      } catch (e) {
        if (e === TimeoutError) {
          break;
        }
      }
      await sleep(50);
    }
    for (let i = 0; i < 7; i++) {
      try {
        await this.sync();
        return true;
      } catch (e) {
        console.log("sync try failed", e);
      }
      await sleep(50);
    }
    // await this.serialPort.setSignals({ dataTerminalReady: false, requestToSend: true });
    // await this.serialPort.setSignals({ dataTerminalReady: true, requestToSend: false });
    // await new Promise((resolve) => setTimeout(resolve, rebootWaitMs));

    return false;
  }

  // private _connect() {
  //   this.closed = false;
  //   this.readPromise = (async () => {
  //     await this.readLoop();
  //     this.readPromise = undefined;
  //   })();
  // }

  /**
   * shutdown the read loop.
   */
  async disconnect(): Promise<void> {
    const p = this.readPromise;
    const reader = this.serialReader;
    if (reader) {
      await reader.cancel();
    }
    if (p) {
      await p;
    }
    return;
  }

  /**
   * @name macAddr
   * Read MAC from OTP ROM
   */
  async macAddr(): Promise<Uint8Array> {
    const efuses = await this.efuses();
    const chipFamily = await this.chipFamily();

    const macAddr = new Uint8Array(6).fill(0);
    const mac0 = efuses[0];
    const mac1 = efuses[1];
    const mac2 = efuses[2];
    const mac3 = efuses[3];
    let oui;
    if (chipFamily === ChipFamily.ESP8266) {
      if (mac3 != 0) {
        oui = [(mac3 >> 16) & 0xff, (mac3 >> 8) & 0xff, mac3 & 0xff];
      } else if (((mac1 >> 16) & 0xff) == 0) {
        oui = [0x18, 0xfe, 0x34];
      } else if (((mac1 >> 16) & 0xff) == 1) {
        oui = [0xac, 0xd0, 0x74];
      } else {
        throw "Couldnt determine OUI";
      }

      macAddr[0] = oui[0];
      macAddr[1] = oui[1];
      macAddr[2] = oui[2];
      macAddr[3] = (mac1 >> 8) & 0xff;
      macAddr[4] = mac1 & 0xff;
      macAddr[5] = (mac0 >> 24) & 0xff;
    } else if (chipFamily === ChipFamily.ESP32 || chipFamily === ChipFamily.ESP32S2) {
      macAddr[0] = (mac2 >> 8) & 0xff;
      macAddr[1] = mac2 & 0xff;
      macAddr[2] = (mac1 >> 24) & 0xff;
      macAddr[3] = (mac1 >> 16) & 0xff;
      macAddr[4] = (mac1 >> 8) & 0xff;
      macAddr[5] = mac1 & 0xff;
    } else {
      throw UnknownChipFamilyError;
    }
    return macAddr;
  }

  /**
   * Read the OTP data for this chip.
   */
  private async readEfuses(): Promise<Uint32Array> {
    const chipFamily = await this.chipFamily();
    let baseAddr;
    if (chipFamily == ChipFamily.ESP8266) {
      baseAddr = 0x3ff00050;
    } else if (chipFamily === ChipFamily.ESP32 || chipFamily === ChipFamily.ESP32S2) {
      baseAddr = 0x6001a000;
    } else {
      throw UnknownChipFamilyError;
    }
    const efuses = new Uint32Array(4);
    console.log("read efuses");
    for (let i = 0; i < 4; i++) {
      efuses[i] = await this.readRegister(baseAddr + 4 * i);
    }
    console.log("efuse", efuses);
    return efuses;
  }

  private async efuses(): Promise<Uint32Array> {
    if (this._efuses === undefined) {
      this._efuses = await this.readEfuses();
    }
    return this._efuses;
  }

  /**
   * Read a register within the ESP chip RAM.
   */
  private async readRegister(reg: number): Promise<number> {
    if (this.options.debug) {
      this.logger.debug("Reading Register", reg);
    }
    const packet = pack("I", reg);
    const register = await this.checkCommand(ESP_READ_REG, packet);
    return unpack("I", register)[0];
  }

  /**
   * ESP32, ESP32S2 or ESP8266 based on which chip type we're talking to.
   */
  async chipFamily(): Promise<ChipFamily> {
    if (this._chipfamily === undefined) {
      const datareg = await this.readRegister(CHIP_DETECT_MAGIC_REG_ADDR);
      if (datareg == ESP32_DETECT_MAGIC_VALUE) {
        this._chipfamily = ChipFamily.ESP32;
      } else if (datareg == ESP8266_DETECT_MAGIC_VALUE) {
        this._chipfamily = ChipFamily.ESP8266;
      } else if (datareg == ESP32S2_DETECT_MAGIC_VALUE) {
        this._chipfamily = ChipFamily.ESP32S2;
      } else {
        throw UnknownChipFamilyError;
      }
    }
    return this._chipfamily;
  }

  /**
   * The specific name of the chip.
   */
  async chipName(): Promise<string> {
    const efuses = await this.efuses();
    const chipFamily = await this.chipFamily();

    if (chipFamily == ChipFamily.ESP32) {
      return "ESP32";
    }
    if (chipFamily == ChipFamily.ESP32S2) {
      return "ESP32-S2";
    }
    if (chipFamily == ChipFamily.ESP8266) {
      if (efuses[0] & (1 << 4) || efuses[2] & (1 << 16)) {
        return "ESP8285";
      }
      return "ESP8266EX";
    }
    throw UnknownChipFamilyError;
  }

  /**
   * Send a command packet, check that the command succeeded.
   */
  private async checkCommand(
    opcode: number,
    buffer: Uint8Array,
    checksum = 0,
    timeout: number = DEFAULT_TIMEOUT
  ): Promise<number[]> {
    timeout = Math.min(timeout, MAX_TIMEOUT);
    await this.sendCommand(opcode, buffer, checksum);
    const resp = await this.getResponse(opcode, timeout);
    const data = resp.data;
    const value = resp.value;
    if (data.length > 4) {
      return data;
    } else {
      return value;
    }
    // let statusLen = 0;
    // if (data !== undefined) {
    //   const chipFamily = this._chipfamily;
    //   if (this.isStub) {
    //     statusLen = 2;
    //   } else if (chipFamily === ChipFamily.ESP8266) {
    //     statusLen = 2;
    //   } else if (chipFamily === ChipFamily.ESP32 || chipFamily === ChipFamily.ESP32S2) {
    //     statusLen = 4;
    //   } else {
    //     if ([2, 4].includes(data.length)) {
    //       statusLen = data.length;
    //     }
    //   }
    // }
    // if (value === undefined || data === undefined || data.length < statusLen) {
    //   throw "Didn't get enough status bytes";
    // }
    // const status = data.slice(-statusLen, data.length);
    // data = data.slice(0, -statusLen);
    // if (this.options.debug) {
    //   this.logger.debug("status", status);
    //   this.logger.debug("value", value);
    //   this.logger.debug("data", data);
    // }
    // if (status[0] == 1) {
    //   if (status[1] == ROM_INVALID_RECV_MSG) {
    //     throw "Invalid (unsupported) command " + toHex(opcode);
    //   } else {
    //     throw "Command failure error code " + toHex(status[1]);
    //   }
    // }
    // return { value, data };
  }

  private _sendCommandBuffer = new Uint8BufferSlipEncode();
  private async sendCommand(opcode: number, buffer: Uint8Array, checksum = 0) {
    // this.inputBuffer.reset(); // Reset input buffer

    const packet = this._sendCommandBuffer;
    packet.reset();
    packet.push(0xc0, 0x00); // direction
    packet.push(opcode);
    packet.pack("H", buffer.length);
    packet.slipEncode = true;
    packet.pack("I", checksum);
    packet.copy(buffer);
    packet.slipEncode = false;
    packet.push(0xc0);

    const res = packet.view();
    if (this.options.debug) {
      this.logger.debug("Writing", res.length, "byte" + (res.length == 1 ? "" : "s") + ":", res);
    }
    await this.writeToStream(res);
  }

  private async getResponse(opcode: number, timeout: number = DEFAULT_TIMEOUT): Promise<commandResult> {
    // let reply: number[] = [];
    // let packetLength = 0;
    // let escapedByte = false;
    // const stamp = Date.now();
    // while (Date.now() - stamp < timeout) {
    //   // let c = await this.inputBuffer.awaitShift(timeout)
    //   if (this.inputBuffer.length > 0) {
    //     const c = this.inputBuffer.shift() || 0;
    //     if (c == 0xdb) {
    //       escapedByte = true;
    //     } else if (escapedByte) {
    //       if (c == 0xdd) {
    //         reply.push(0xdc);
    //       } else if (c == 0xdc) {
    //         reply.push(0xc0);
    //       } else {
    //         reply = reply.concat([0xdb, c]);
    //       }
    //       escapedByte = false;
    //     } else {
    //       reply.push(c);
    //     }
    //   } else {
    //     await sleep(10);
    //   }
    //   if (reply.length > 0 && reply[0] != 0xc0) {
    //     // packets must start with 0xC0
    //     reply.shift();
    //   }
    //   if (reply.length > 1 && reply[1] != 0x01) {
    //     reply.shift();
    //   }
    //   if (reply.length > 2 && reply[2] != opcode) {
    //     reply.shift();
    //   }
    //   if (reply.length > 4) {
    //     // get the length
    //     packetLength = reply[3] + (reply[4] << 8);
    //   }
    //   if (reply.length == packetLength + 10) {
    //     break;
    //   }
    // }

    try {
      console.log("trying to read", timeout);
      const reply = await this.read2(true, timeout);
      if (this.options.debug) {
        this.logger.debug("Reading", reply.length, "byte" + (reply.length == 1 ? "" : "s") + ":", reply);
      }
      const opcode_ret = reply[1];
      console.log("Opcode", opcode, "response", opcode_ret, "reply", reply);
      if (opcode !== opcode_ret) {
        throw "invalid opcode response";
      }
      const res = Array.from<number>(reply);
      const value = res.slice(4, 8);
      const data = res.slice(8, -1);
      if (this.options.debug) {
        this.logger.debug("value:", value, "data:", data);
      }
      return { value, data };
    } catch (e) {
      console.log("received", e);
      throw e;
    }

    // // Check to see if we have a complete packet. If not, we timed out.
    // if (reply.length != packetLength + 10) {
    //   this.logger.debug("Timed out after", timeout, "milliseconds");
    //   return { value: undefined, data: undefined };
    // }
    // if (this.options.debug) {
    //   this.logger.debug("Reading", reply.length, "byte" + (reply.length == 1 ? "" : "s") + ":", reply);
    // }
    // const value = reply.slice(5, 9);
    // const data = reply.slice(9, -1);
    // if (this.options.debug) {
    //   this.logger.debug("value:", value, "data:", data);
    // }
    // return { value, data };
  }

  // private async readBuffer(timeout: number = DEFAULT_TIMEOUT): Promise<Uint8Array | null> {
  //   let reply: number[] = [];
  //   let escapedByte = false;
  //   const stamp = Date.now();
  //   while (Date.now() - stamp < timeout) {
  //     if (this.inputBuffer.length > 0) {
  //       const c = this.inputBuffer.shift() || 0;
  //       if (c == 0xdb) {
  //         escapedByte = true;
  //       } else if (escapedByte) {
  //         if (c == 0xdd) {
  //           reply.push(0xdc);
  //         } else if (c == 0xdc) {
  //           reply.push(0xc0);
  //         } else {
  //           reply = reply.concat([0xdb, c]);
  //         }
  //         escapedByte = false;
  //       } else {
  //         reply.push(c);
  //       }
  //     } else {
  //       await sleep(10);
  //     }
  //     if (reply.length > 0 && reply[0] != 0xc0) {
  //       // packets must start with 0xC0
  //       reply.shift();
  //     }
  //     if (reply.length > 1 && reply[reply.length - 1] == 0xc0) {
  //       break;
  //     }
  //   }
  //   // Check to see if we have a complete packet. If not, we timed out.
  //   if (reply.length < 2) {
  //     this.logger.log("Timed out after", timeout, "milliseconds");
  //     return null;
  //   }
  //   if (this.options.debug) {
  //     this.logger.debug("Reading", reply.length, "byte" + (reply.length == 1 ? "" : "s") + ":", reply);
  //   }
  //   const data = reply.slice(1, -1);
  //   if (this.options.debug) {
  //     this.logger.debug("data:", data);
  //   }
  //   return Uint8Array.from(data);
  // }

  // private async readLoop() {
  //   this.inputBuffer.reset();
  //   try {
  //     while (!this.closed) {
  //       try {
  //         await this.readLoopInner();
  //       } catch (e) {
  //         const rethrow = !isTransientError(e);
  //         if (this.options.debug) {
  //           this.logger.debug("readLoop error", e, "rethrow?", rethrow);
  //         }
  //         if (rethrow) {
  //           throw e;
  //         }
  //       }
  //     }
  //   } finally {
  //     this.closed = true;
  //   }
  // }

  // private async readLoopInner() {
  //   this.serialReader = this.serialPort.readable.getReader();
  //   try {
  //     while (!this.closed) {
  //       const { value, done } = await this.serialReader.read();
  //       if (done) {
  //         break;
  //       }
  //       if (value) {
  //         this.inputBuffer.copy(value);
  //       }
  //     }
  //   } finally {
  //     await this.serialReader.cancel();
  //     this.serialReader.releaseLock();
  //     this.serialReader = undefined;
  //     this.closed = true;
  //   }
  // }

  private static checksum(data: Uint8Array, state: number = ESP_CHECKSUM_MAGIC): number {
    for (const b of data) {
      state ^= b;
    }
    return state;
  }

  /**
   * Change the baud rate for the serial port.
   */
  async setBaudRate(prevBaud: number, baud: number): Promise<void> {
    this.logger.log("Attempting to change baud rate from", prevBaud, "to", baud, "...");
    // Signal ESP32 stub that we will change the baud rate
    const buffer = pack("<II", baud, this.isStub ? prevBaud : 0);
    await this.checkCommand(ESP_CHANGE_BAUDRATE, buffer);

    // Close the read loop and port
    await this.disconnect();
    await this.serialPort.close();

    // Reopen the port and read loop
    await this.serialPort.open({ baudRate: baud });
    await sleep(50);
    try {
      await this.read(false, 500);
    } catch (e) {}
    // this._connect();

    // Baud rate was changed
    this.logger.log("Changed baud rate to", baud);
  }

  /**
   * Put into ROM bootload mode & attempt to synchronize with the
   * ESP ROM bootloader, we will retry a few times
   */
  private async sync(): Promise<void> {
    await this.sendCommand(ESP_SYNC, SYNC_PACKET);
    const { data } = await this.getResponse(ESP_SYNC, SYNC_TIMEOUT);
    if (data.length > 1 && data[0] == 0 && data[1] == 0) {
      return;
    }
    throw "sync error";
    // try {

    // } catch (e) {
    //   console.log("sync error", e);
    // }
  }

  private async getFlashWriteSize(): Promise<number> {
    const chipFamily = this.isStub ? null : await this.chipFamily();
    if (chipFamily === ChipFamily.ESP32S2) {
      return ESP32S2_FLASH_WRITE_SIZE;
    }
    return FLASH_WRITE_SIZE;
  }

  /**
   * Write data to the flash.
   */
  async flashData(
    binaryData: Uint8Array,
    offset = 0,
    progressCallback: progressCallback | undefined = undefined,
    encrypted = false
  ): Promise<void> {
    binaryData = padTo(binaryData, encrypted ? 32 : 4);
    const filesize = binaryData.byteLength;
    this.logger.log("Writing data with filesize:", filesize);
    const blocks = await this.flashBegin(filesize, offset);
    let seq = 0;
    const address = offset;
    let position = 0;
    const stamp = Date.now();
    const flashWriteSize = await this.getFlashWriteSize();
    let block: Uint8Array;

    while (filesize - position > 0) {
      if (this.options.debug) {
        this.logger.debug("Writing at " + toHex(address + seq * flashWriteSize, 8) + "... (", (seq + 1) / blocks, "%)");
      }
      if (progressCallback) {
        progressCallback(seq, blocks);
      }
      if (filesize - position >= flashWriteSize) {
        block = binaryData.subarray(position, position + flashWriteSize);
      } else {
        // Pad the last block
        block = binaryData.subarray(position, filesize);
      }
      await this.flashBlock(block, flashWriteSize, seq, 2000);
      seq += 1;
      position += flashWriteSize;
    }
    if (this.isStub) {
      await this.readRegister(CHIP_DETECT_MAGIC_REG_ADDR);
    }
    if (this.options.debug) {
      this.logger.debug("Took", Date.now() - stamp, "ms to write", filesize, "bytes");
    }
  }

  private _flashBlockBuffer = new Uint8Buffer();
  private async flashBlock(data: Uint8Array, flashWriteSize: number, seq: number, timeout = 100) {
    const buffer = this._flashBlockBuffer;
    buffer.reset();
    buffer.pack("<IIII", flashWriteSize, seq, 0, 0);
    buffer.copy(data);
    if (data.length < flashWriteSize) {
      buffer.fill(0xff, flashWriteSize - data.length);
    }
    await this.checkCommand(ESP_FLASH_DATA, buffer.view(), EspLoader.checksum(data), timeout);
  }

  private async flashBegin(size = 0, offset = 0, encrypted = false) {
    let eraseSize;
    const buffer = new Uint8Buffer(32);
    const chipFamily = this.isStub ? null : await this.chipFamily();
    const flashWriteSize = await this.getFlashWriteSize();
    if (chipFamily === ChipFamily.ESP32 || chipFamily === ChipFamily.ESP32S2) {
      await this.checkCommand(ESP_SPI_ATTACH, new Uint8Array(8).fill(0));
    }
    if (chipFamily == ChipFamily.ESP32) {
      // We are hardcoded for 4MB flash on ESP32
      buffer.pack("<IIIIII", 0, this.options.flashSize, 0x10000, 4096, 256, 0xffff);
      await this.checkCommand(ESP_SPI_SET_PARAMS, buffer.view());
    }
    const numBlocks = Math.floor((size + flashWriteSize - 1) / flashWriteSize);
    if (chipFamily == ChipFamily.ESP8266) {
      eraseSize = EspLoader.getEraseSize(offset, size);
    } else {
      eraseSize = size;
    }

    let timeout;
    if (this.isStub) {
      timeout = DEFAULT_TIMEOUT;
    } else {
      timeout = timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    const stamp = Date.now();
    buffer.reset();
    buffer.pack("<IIII", eraseSize, numBlocks, flashWriteSize, offset);
    if (chipFamily == ChipFamily.ESP32S2) {
      buffer.pack("<I", encrypted ? 1 : 0);
    }
    this.logger.log(
      "Erase size",
      eraseSize,
      " blocks ",
      numBlocks,
      " block size ",
      flashWriteSize,
      " offset " + toHex(offset, 4) + ", encrypted " + (encrypted ? "yes" : "no")
    );
    await this.checkCommand(ESP_FLASH_BEGIN, buffer.view(), 0, timeout);
    if (size != 0 && !this.isStub) {
      this.logger.log("Took", Date.now() - stamp, "ms to erase", numBlocks, "bytes");
    }
    return numBlocks;
  }

  /**
   * Leave flash mode and run/reboot
   *
   * @param reboot wheather or not to reboot
   */
  async flashFinish(reboot = false): Promise<void> {
    await this.flashBegin(0, 0);
    const buffer = pack("<I", reboot ? 0 : 1);
    await this.checkCommand(ESP_FLASH_END, buffer);
  }

  /**
   * Calculate an erase size given a specific size in bytes.
   * Provides a workaround for the bootloader erase bug.
   */
  private static getEraseSize(offset: number, size: number): number {
    const sectorsPerBlock = 16;
    const sectorSize = FLASH_SECTOR_SIZE;
    const numSectors = Math.floor((size + sectorSize - 1) / sectorSize);
    const startSector = Math.floor(offset / sectorSize);

    let headSectors = sectorsPerBlock - (startSector % sectorsPerBlock);
    if (numSectors < headSectors) {
      headSectors = numSectors;
    }

    if (numSectors < 2 * headSectors) {
      return Math.floor(((numSectors + 1) / 2) * sectorSize);
    }

    return (numSectors - headSectors) * sectorSize;
  }

  private async memBegin(size: number, blocks: number, blockSize: number, offset: number) {
    if (this.isStub) {
      const chipFamily = await this.chipFamily();
      const stub = getStub(chipFamily);
      const load_start = offset;
      const load_end = offset + size;
      this.logger.log(load_start, load_end);
      this.logger.log(stub.dataStart, stub.data.length, stub.textStart, stub.text.length);
      for (const [start, end] of [
        [stub.dataStart, stub.dataStart + stub.data.length],
        [stub.textStart, stub.textStart + stub.text.length],
      ]) {
        if (load_start < end && load_end > start) {
          throw (
            "Software loader is resident at " +
            toHex(start, 8) +
            "-" +
            toHex(end, 8) +
            ". " +
            "Can't load binary at overlapping address range " +
            toHex(load_start, 8) +
            "-" +
            toHex(load_end, 8) +
            ". " +
            "Try changing the binary loading address."
          );
        }
      }
    }

    return this.checkCommand(ESP_MEM_BEGIN, pack("<IIII", size, blocks, blockSize, offset));
  }

  private _memBlockBuffer = new Uint8Buffer();
  private async memBlock(data: Uint8Array, seq: number) {
    const buffer = this._memBlockBuffer;
    buffer.reset();
    buffer.pack("<IIII", data.length, seq, 0, 0);
    buffer.copy(data);
    return await this.checkCommand(ESP_MEM_DATA, buffer.view(), EspLoader.checksum(data));
  }

  private async memFinish(entrypoint = 0) {
    const timeout = this.isStub ? DEFAULT_TIMEOUT : MEM_END_ROM_TIMEOUT;
    const data = pack("<II", entrypoint === 0 ? 1 : 0, entrypoint);
    try {
      return await this.checkCommand(ESP_MEM_END, data, 0, timeout);
    } catch (e) {
      if (this.isStub) {
        throw e;
      }
    }
  }

  /**
   * loads the stub onto the device.
   *
   * @param stub Stub to load
   */
  async loadStub(stub?: Stub): Promise<void> {
    // We're transferring over USB, right?
    const ramBlock = USB_RAM_BLOCK;

    const writeMem = async (data: Uint8Array, offset: number) => {
      const length = data.length;
      const blocks = Math.floor((length + ramBlock - 1) / ramBlock);
      await this.memBegin(length, blocks, ramBlock, offset);
      for (const seq of Array(blocks).keys()) {
        const fromOffs = seq * ramBlock;
        let toOffs = fromOffs + ramBlock;
        if (toOffs > length) {
          toOffs = length;
        }
        await this.memBlock(data.slice(fromOffs, toOffs), seq);
      }
    };

    const chipFamily = await this.chipFamily();
    if (stub === undefined) {
      stub = getStub(chipFamily);
    }

    this.logger.log("Uploading stub...");
    await writeMem(stub.text, stub.textStart);
    await writeMem(stub.data, stub.dataStart);
    this.logger.log("Running stub...");
    await this.memFinish(stub.entry);

    const p = await this.read(true, 1000, 6);
    const str = String.fromCharCode(...p);
    if (str !== "OHAI") {
      throw "Failed to start stub. Unexpected response: " + str;
    }
    this.logger.log("Stub is now running...");
    this.isStub = true;
    this._chipfamily = undefined;
    this._efuses = undefined;
  }

  private async read(packetMode = true, timeoutMs = 1000, minRead = 12): Promise<Uint8Array> {
    if (this.serialReader !== undefined) {
      throw "Read already in progress";
    }
    const reader = this.serialPort.readable.getReader();
    this.serialReader = reader;
    const read = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        console.log("timeout executed");
        await reader.cancel();
      }, timeoutMs);
      const clear = async () => {
        clearTimeout(timeout);
        this.serialReader = undefined;
        this.readPromise = undefined;
        await reader.cancel();
        reader.releaseLock();
      };
      this._read(reader, packetMode, minRead)
        .then(async (res) => {
          await clear();
          resolve(res);
        })
        .catch(async (e) => {
          await clear();
          reject(e);
        });
    });
    this.readPromise = read;
    return await read;
  }

  private readBuffer = new Uint8BufferSlipEncode();
  private async _read(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    packetMode = true,
    minRead = 12
  ): Promise<Uint8Array> {
    this.readBuffer.reset();
    while (this.readBuffer.length < minRead) {
      const { value, done } = await reader.read();
      if (done) {
        throw TimeoutError;
      }
      if (value) {
        this.readBuffer.copy(value);
      }
    }
    if (packetMode) {
      return this.readBuffer.packet(true);
    }
    return this.readBuffer.view();
  }

  private async read2(packetMode = true, timeoutMs = 1000, min_data = 12) {
    this.readBuffer.reset();
    const reader = this.serialPort.readable.getReader();
    const t = setTimeout(async function () {
      await reader.cancel();
      reader.releaseLock();
    }, timeoutMs);

    let timeout = false;
    do {
      this.serialReader = reader;
      const { value, done } = await reader.read();
      this.serialReader = undefined;
      if (value) {
        this.readBuffer.copy(value);
      }
      if (done) {
        timeout = true;
        break;
      }
    } while (this.readBuffer.length < min_data);

    clearTimeout(t);
    await reader.cancel();
    reader.releaseLock();
    if (timeout) {
      throw TimeoutError;
    }

    if (packetMode) {
      return this.readBuffer.packet(true);
    }
    return this.readBuffer.view();
  }

  /**
   * erase the flash of the device
   *
   * @param timeoutMs the timeout of erasing
   */
  async eraseFlash(timeoutMs: number = CHIP_ERASE_TIMEOUT): Promise<void> {
    if (!this.isStub) {
      throw "Only supported on stub";
    }
    await this.checkCommand(ESP_ERASE_FLASH, emptyByteArray, 0, timeoutMs);
  }
}

function getStub(chipFamily: ChipFamily): Stub {
  switch (chipFamily) {
    case ChipFamily.ESP32:
      return ESP32;
    default:
      throw "Unsupported chipFamily: " + chipFamily;
  }
}

function padTo(image: Uint8Array, alignment: number, padding = 0xff): Uint8Array {
  const pad = image.byteLength % alignment;
  if (pad == 0) {
    return image;
  }
  const res = new Uint8Array(image.byteLength + (alignment - pad));
  res.set(image);
  res.fill(padding, image.byteLength);
  return res;
}

/**
 * Scales timeouts which are size-specific
 */
function timeoutPerMb(secondsPerMb: number, sizeBytes: number): number {
  const result = Math.floor(secondsPerMb * (sizeBytes / 0x1e6));
  if (result < DEFAULT_TIMEOUT) {
    return DEFAULT_TIMEOUT;
  }
  return result;
}

function pack(format: string, ...args: number[]): Uint8Array {
  let pointer = 0;
  const data = args;
  if (format.replace(/[<>]/, "").length != data.length) {
    throw "Pack format to Argument count mismatch";
  }
  const bytes: number[] = [];
  let littleEndian = true;
  for (let i = 0; i < format.length; i++) {
    if (format[i] == "<") {
      littleEndian = true;
    } else if (format[i] == ">") {
      littleEndian = false;
    } else if (format[i] == "B") {
      pushBytes(data[pointer], 1);
      pointer++;
    } else if (format[i] == "H") {
      pushBytes(data[pointer], 2);
      pointer++;
    } else if (format[i] == "I") {
      pushBytes(data[pointer], 4);
      pointer++;
    } else {
      throw "Unhandled character in pack format";
    }
  }

  function pushBytes(value: number, byteCount: number) {
    for (let i = 0; i < byteCount; i++) {
      if (littleEndian) {
        bytes.push((value >> (i * 8)) & 0xff);
      } else {
        bytes.push((value >> ((byteCount - i) * 8)) & 0xff);
      }
    }
  }

  return Uint8Array.from(bytes);
}

function unpack(format: string, bytes: number[]): number[] {
  let pointer = 0;
  const data = [];
  for (const c of format) {
    if (c == "B") {
      data.push(bytes[pointer] & 0xff);
      pointer += 1;
    } else if (c == "H") {
      data.push((bytes[pointer] & 0xff) | ((bytes[pointer + 1] & 0xff) << 8));
      pointer += 2;
    } else if (c == "I") {
      data.push(
        (bytes[pointer] & 0xff) |
          ((bytes[pointer + 1] & 0xff) << 8) |
          ((bytes[pointer + 2] & 0xff) << 16) |
          ((bytes[pointer + 3] & 0xff) << 24)
      );
      pointer += 4;
    } else {
      throw "Unhandled character in unpack format";
    }
  }
  return data;
}

const emptyByteArray = new Uint8Array();
