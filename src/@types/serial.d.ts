// Copyright (C) 2021 Toitware ApS. All rights reserved.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.
export declare global {
  interface Serial {
    onconnect: EventHandlerNonNull;
    ondisconnect: EventHandlerNonNull;

    getPorts(): Promise<SerialPort[]>;
    requestPort(options: SerialPortRequestOptions): Promise<SerialPort>;
  }

  interface SerialPortRequestOptions {
    filters: SerialPortFilter[];
  }

  interface SerialPortFilter {
    usbVendorId: number | undefined;
    usbProductId: number | undefined;
  }

  interface SerialPort {
    onconnect: EventHandlerNonNull;
    ondisconnect: EventHandlerNonNull;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    baudRate: number;

    getInfo(): SerialPortInfo;

    open(options: SerialOptions): Promise<undefined>;
    setSignals(signals: SerialOutputSignals): Promise<void>;
    getSignals(): Promise<SerialInputSignals>;
    close(): Promise<undefined>;
  }

  enum ParityType {
    None = "none",
    Even = "even",
    Odd = "odd",
  }

  enum FlowControlType {
    None = "none",
    Hardware = "hardware",
  }

  interface SerialOptions {
    baudRate: number;
    parity?: ParityType;
    flowControl?: FlowControlType;
  }

  interface SerialPortInfo {
    usbVendorId: number;
    usbProductId: number;
  }

  interface SerialOutputSignals {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
  }

  interface SerialInputSignals {
    dataCarrierDetect: boolean;
    clearToSend: boolean;
    ringIndicator: boolean;
    dataSetReady: boolean;
  }

  interface Navigator {
    serial: Serial;
  }
}
